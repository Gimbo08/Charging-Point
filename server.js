const http = require('http');
const express = require('express');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const admin = require('firebase-admin');
const { WebSocketServer } = require('ws');

admin.initializeApp();
const firebaseAuth = admin.auth();

const app = express();
const db = new Firestore({ ignoreUndefinedProperties: true });
const firestoreEnabled = process.env.FIRESTORE_DISABLED !== 'true';
const chargePointCollection = 'chargePoints';
const eventCollection = 'ocppEvents';
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean));
app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  return next();
});
app.use(express.json());

const port = Number(process.env.PORT || 8080);
const configuredChargePointId = process.env.CHARGE_POINT_ID || '';
const ocppPassword = process.env.OCPP_PASSWORD || '';
const manualApiToken = process.env.MANUAL_API_TOKEN || '';
const ocppIdTag = process.env.OCPP_ID_TAG || 'ChargingPoint';
const authDisabledIdTag = process.env.AUTH_DISABLED_ID_TAG || 'NoAuthorization';
const chargePoints = new Map();
const pendingCalls = new Map();
let profileSequence = 1;

function isAuthorized(request, chargePointId) {
  if (!configuredChargePointId || !ocppPassword || chargePointId !== configuredChargePointId) {
    return false;
  }

  const header = request.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    return false;
  }

  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return username === configuredChargePointId && password === ocppPassword;
  } catch {
    return false;
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'charging-point-ocpp', chargePoints: chargePoints.size });
});

async function requireFirebaseUser(request, response, next) {
  const header = request.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return response.status(401).json({ error: 'Authentication required' });
  try {
    request.user = await firebaseAuth.verifyIdToken(header.slice(7));
    return next();
  } catch {
    return response.status(401).json({ error: 'Invalid authentication token' });
  }
}

function parseCurrentLimit(value) {
  const amps = Number(value);
  if (!Number.isInteger(amps) || amps < 6 || amps > 32) return null;
  return amps;
}

function sendOcppCall(ws, action, payload) {
  const uniqueId = `cp-${Date.now()}-${profileSequence++}`;
  console.log(JSON.stringify({ event: 'ocpp_call_sent', uniqueId, action, payload }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCalls.delete(uniqueId);
      reject(new Error(`Timeout waiting for ${action}`));
    }, 15000);
    pendingCalls.set(uniqueId, { resolve, reject, timeout });
    ws.send(JSON.stringify([2, uniqueId, action, payload]), (error) => {
      if (error) {
        clearTimeout(timeout);
        pendingCalls.delete(uniqueId);
        reject(error);
      }
    });
  });
}

app.get('/api/ocpp-events', requireFirebaseUser, async (_req, res) => {
  if (!firestoreEnabled) return res.json([]);
  try {
    const snapshot = await db.collection(eventCollection)
      .where('chargePointId', '==', configuredChargePointId)
      .orderBy('createdAt', 'desc')
      .limit(30)
      .get();
    return res.json(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/ocpp-configuration', requireFirebaseUser, async (_req, res) => {
  const point = chargePoints.get(configuredChargePointId);
  if (!point?.ws || point.ws.readyState !== 1) return res.status(409).json({ error: 'Charge point is not connected' });
  try {
    const response = await sendOcppCall(point.ws, 'GetConfiguration', {
      key: ['AuthorizeRemoteTxRequests', 'AuthEnabled', 'LocalAuthListEnabled', 'AllowOfflineTxForUnknownId', 'AuthDisabledIdTag', 'StopTransactionOnEVSideDisconnect'],
    });
    return res.json({ ok: true, response });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.post('/api/enable-remote-start', requireFirebaseUser, async (req, res) => {
  const point = chargePoints.get(configuredChargePointId);
  if (!point?.ws || point.ws.readyState !== 1) return res.status(409).json({ error: 'Charge point is not connected' });
  try {
    const configuration = await sendOcppCall(point.ws, 'ChangeConfiguration', {
      key: 'AuthorizeRemoteTxRequests',
      value: 'true',
    });
    const localList = await sendOcppCall(point.ws, 'SendLocalList', {
      listVersion: 1,
      localAuthorizationList: [{
        idTag: ocppIdTag,
        idTagInfo: { status: 'Accepted' },
      }],
      updateType: 'Full',
    });
    const verification = await sendOcppCall(point.ws, 'GetConfiguration', {
      key: ['AuthorizeRemoteTxRequests', 'AuthEnabled', 'LocalAuthListEnabled'],
    });
    const event = { configuration, localList, verification, updatedAt: new Date().toISOString(), updatedBy: req.user.uid };
    if (firestoreEnabled) await persistEvent(configuredChargePointId, 'EnableRemoteStart', event);
    return res.json({ ok: true, ...event });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.post('/api/recovery-action', requireFirebaseUser, async (req, res) => {
  const action = req.body?.action;
  const point = chargePoints.get(configuredChargePointId);
  if (!point?.ws || point.ws.readyState !== 1) return res.status(409).json({ error: 'Charge point is not connected' });
  const commands = {
    clearProfiles: ['ClearChargingProfile', {}],
    operative: ['ChangeAvailability', { connectorId: 1, type: 'Operative' }],
    resetSoft: ['Reset', { type: 'Soft' }],
    unlock: ['UnlockConnector', { connectorId: 1 }],
  };
  if (!commands[action]) return res.status(400).json({ error: 'Unknown recovery action' });
  try {
    const [command, payload] = commands[action];
    const response = await sendOcppCall(point.ws, command, payload);
    const event = { action, command, response, updatedAt: new Date().toISOString(), updatedBy: req.user.uid };
    if (firestoreEnabled) await persistEvent(configuredChargePointId, 'RecoveryAction', event);
    return res.json({ ok: true, ...event });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.post('/api/manual-mode', requireFirebaseUser, async (req, res) => {

  const amps = parseCurrentLimit(req.body?.currentLimitA);
  if (amps === null) return res.status(400).json({ error: 'currentLimitA must be an integer from 6 to 32 A' });

  const point = chargePoints.get(configuredChargePointId);
  if (!point?.ws || point.ws.readyState !== 1) return res.status(409).json({ error: 'Charge point is not connected' });

  const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    return res.status(400).json({ error: 'expiresAt must be a future ISO date' });
  }

  const profile = {
    connectorId: 1,
    csChargingProfiles: {
      chargingProfileId: profileSequence,
      stackLevel: 0,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      validFrom: new Date().toISOString(),
      ...(expiresAt ? { validTo: expiresAt.toISOString() } : {}),
      chargingSchedule: {
        chargingRateUnit: 'A',
        ...(expiresAt ? { duration: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) } : {}),
        chargingSchedulePeriod: [{ startPeriod: 0, limit: amps }],
      },
    },
  };

  try {
    const response = await sendOcppCall(point.ws, 'SetChargingProfile', profile);
    const mode = { mode: 'manual', currentLimitA: amps, expiresAt: expiresAt?.toISOString() || null, updatedAt: new Date().toISOString(), updatedBy: req.user.uid };
    point.manualMode = mode;
    if (firestoreEnabled) {
      await db.collection(chargePointCollection).doc(configuredChargePointId).set({ manualMode: mode }, { merge: true });
      await persistEvent(configuredChargePointId, 'SetChargingProfile', { currentLimitA: amps, expiresAt: mode.expiresAt, response });
    }
    return res.json({ ok: true, mode, response });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.post('/api/charging-action', requireFirebaseUser, async (req, res) => {
  const action = req.body?.action;
  console.log(JSON.stringify({ event: 'charging_action_requested', action, user: req.user.uid }));
  if (!['start', 'stop'].includes(action)) return res.status(400).json({ error: 'action must be start or stop' });

  const point = chargePoints.get(configuredChargePointId);
  if (!point?.ws || point.ws.readyState !== 1) return res.status(409).json({ error: 'Charge point is not connected' });

  try {
    const limit = action === 'start' ? parseCurrentLimit(point.manualMode?.currentLimitA || 6) : 0;
    const profile = {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: profileSequence++,
        stackLevel: 10,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Absolute',
        validFrom: new Date().toISOString(),
        chargingSchedule: {
          chargingRateUnit: 'A',
          chargingSchedulePeriod: [{ startPeriod: 0, limit }],
        },
      },
    };

    const profileResponse = await sendOcppCall(point.ws, 'SetChargingProfile', profile);
    const profileStatus = profileResponse?.status || 'Unknown';
    if (profileStatus !== 'Accepted') {
      return res.status(409).json({ ok: false, action, responseStatus: profileStatus, message: `La wallbox ha rifiutato il limite di corrente: ${profileStatus}.` });
    }

    let transactionResponse = null;
    let transactionStatus = null;
    if (action === 'start') {
      transactionResponse = await sendOcppCall(point.ws, 'RemoteStartTransaction', {
        idTag: ocppIdTag,
      });
      transactionStatus = transactionResponse?.status || 'Unknown';
    } else if (point.transactionId) {
      transactionResponse = await sendOcppCall(point.ws, 'RemoteStopTransaction', { transactionId: point.transactionId });
      transactionStatus = transactionResponse?.status || 'Unknown';
    }

    const accepted = action === 'start' ? transactionStatus === 'Accepted' : (!transactionStatus || transactionStatus === 'Accepted');
    const event = {
      action,
      requestedLimitA: limit,
      profileResponse,
      profileStatus,
      transactionResponse,
      transactionStatus,
      transactionId: point.transactionId || null,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.uid,
    };
    console.log(JSON.stringify({ event: 'charging_action_response', ...event }));
    if (firestoreEnabled) await persistEvent(configuredChargePointId, 'ChargingAction', event);
    const message = accepted
      ? (action === 'start' ? `Avvio ricarica inviato a ${limit} A.` : 'Stop ricarica inviato.')
      : `La wallbox ha risposto: ${transactionStatus || profileStatus}.`;
    return res.status(accepted ? 200 : 409).json({ ok: accepted, ...event, responseStatus: transactionStatus || profileStatus, message });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.get('/api/charge-points', requireFirebaseUser, async (_req, res) => {
  if (firestoreEnabled) {
    try {
      const snapshot = await db.collection(chargePointCollection).get();
      return res.json(snapshot.docs.map((doc) => {
        const data = doc.data();
        const live = chargePoints.get(data.id);
        if (!live) return { ...data, ocppConnected: false, status: 'Disconnected' };
        return { ...data, ...Object.fromEntries(Object.entries(live).filter(([key]) => key !== 'ws')) };
      }));
    } catch (error) {
      console.error('Firestore read failed:', error.message);
    }
  }

  res.json([...chargePoints.values()].map(({ ws, ...point }) => point));
});

async function persistPoint(point) {
  if (!firestoreEnabled) return;
  const { ws, ...data } = point;
  await db.collection(chargePointCollection).doc(data.id).set({
    ...data,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function persistEvent(chargePointId, action, payload) {
  if (!firestoreEnabled) return;
  await db.collection(eventCollection).add({
    chargePointId,
    action,
    payload,
    createdAt: FieldValue.serverTimestamp(),
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => protocols.has('ocpp1.6') ? 'ocpp1.6' : false,
});

server.on('upgrade', (request, socket, head) => {
  if (!request.url.startsWith('/ocpp')) {
    socket.destroy();
    return;
  }

  const chargePointId = decodeURIComponent(request.url.split('/').filter(Boolean)[1] || 'unknown');
  if (!isAuthorized(request, chargePointId)) {
    socket.write('HTTP/1.1 401 Unauthorized\\r\\nWWW-Authenticate: Basic realm="OCPP"\\r\\nConnection: close\\r\\n\\r\\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.chargePointId = chargePointId;
    wss.emit('connection', ws, request);
  });
});

function sendCallResult(ws, uniqueId, payload) {
  ws.send(JSON.stringify([3, uniqueId, payload]));
}

function sendCallError(ws, uniqueId, code, description, details = {}) {
  ws.send(JSON.stringify([4, uniqueId, code, description, details]));
}

wss.on('connection', (ws) => {
  const id = ws.chargePointId;
  const point = {
    id,
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    status: 'Connected',
    ocppConnected: true,
    ws,
  };
  chargePoints.set(id, point);
  persistPoint(point).catch((error) => console.error('Firestore point write failed:', error.message));

  ws.on('message', (raw) => {
    point.lastSeenAt = new Date().toISOString();

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      ws.close(1007, 'Invalid JSON');
      return;
    }

    if (!Array.isArray(message) || message.length < 3) {
      ws.close(1007, 'Invalid OCPP message');
      return;
    }

    const [messageType, uniqueId, action, payload] = message;
    if (messageType === 3 || messageType === 4) {
      const pending = pendingCalls.get(uniqueId);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingCalls.delete(uniqueId);
        if (messageType === 3) {
          console.log(JSON.stringify({ event: 'ocpp_call_result', uniqueId, payload: action }));
          persistEvent(id, 'CALLRESULT', { uniqueId, payload: action }).catch((error) => console.error('Firestore result write failed:', error.message));
          pending.resolve(action);
        } else {
          console.error(JSON.stringify({ event: 'ocpp_call_error', uniqueId, errorCode: action, description: payload }));
          persistEvent(id, 'CALLERROR', { uniqueId, errorCode: action, description: payload }).catch((error) => console.error('Firestore error write failed:', error.message));
          pending.reject(new Error(`${action || 'OCPP error'}: ${payload || ''}`));
        }
      }
      return;
    }
    if (messageType !== 2) {
      return;
    }

    persistEvent(id, action, payload).catch((error) => console.error('Firestore event write failed:', error.message));

    switch (action) {
      case 'Authorize':
        sendCallResult(ws, uniqueId, {
          idTagInfo: {
            status: [ocppIdTag, authDisabledIdTag].includes(payload?.idTag) ? 'Accepted' : 'Invalid',
          },
        });
        break;
      case 'BootNotification':
        point.vendor = payload?.chargePointVendor;
        point.model = payload?.chargePointModel;
        point.status = 'Available';
        sendCallResult(ws, uniqueId, {
          currentTime: new Date().toISOString(),
          interval: 300,
          status: 'Accepted',
        });
        persistPoint(point).catch((error) => console.error('Firestore point write failed:', error.message));
        break;
      case 'Heartbeat':
        sendCallResult(ws, uniqueId, { currentTime: new Date().toISOString() });
        persistPoint(point).catch((error) => console.error('Firestore point write failed:', error.message));
        break;
      case 'StatusNotification':
        point.status = payload?.status || point.status;
        point.connectorId = payload?.connectorId;
        sendCallResult(ws, uniqueId, {});
        persistPoint(point).catch((error) => console.error('Firestore point write failed:', error.message));
        break;
      case 'MeterValues':
        point.meterValues = payload?.meterValue || [];
        if (payload?.transactionId !== undefined && payload?.transactionId !== null) {
          point.transactionId = Number(payload.transactionId);
        }
        const latestEnergyWh = Number(point.meterValues.at(-1)?.sampledValue?.find((item) => item.measurand === 'Energy.Active.Import.Register')?.value);
        if (Number.isFinite(latestEnergyWh) && Number.isFinite(point.sessionStartEnergyWh)) {
          point.sessionEnergyWh = Math.max(0, latestEnergyWh - point.sessionStartEnergyWh);
        }
        const latestPowerW = Number(point.meterValues.at(-1)?.sampledValue?.find((item) => item.measurand === 'Power.Active.Import')?.value);
        point.measuredPowerW = Number.isFinite(latestPowerW) ? latestPowerW : null;
        point.energyFlowing = Number.isFinite(latestPowerW) && latestPowerW > 10;
        sendCallResult(ws, uniqueId, {});
        persistPoint(point).catch((error) => console.error('Firestore point write failed:', error.message));
        break;
      case 'StartTransaction':
        point.transactionId = Date.now();
        point.sessionStartEnergyWh = Number(payload?.meterStart) || null;
        point.sessionEnergyWh = 0;
        point.status = 'Charging';
        sendCallResult(ws, uniqueId, { transactionId: point.transactionId, idTagInfo: { status: 'Accepted' } });
        persistPoint(point).catch((error) => console.error('Firestore point write failed:', error.message));
        break;
      case 'StopTransaction':
        point.status = 'Available';
        point.transactionId = undefined;
        point.sessionStartEnergyWh = undefined;
        point.sessionEnergyWh = undefined;
        sendCallResult(ws, uniqueId, { idTagInfo: { status: 'Accepted' } });
        persistPoint(point).catch((error) => console.error('Firestore point write failed:', error.message));
        break;
      default:
        sendCallError(ws, uniqueId, 'NotImplemented', `Action ${action} is not implemented`);
    }
  });

  ws.on('close', () => {
    if (chargePoints.get(id)?.ws === ws) {
      chargePoints.delete(id);
    }
    if (firestoreEnabled) {
      db.collection(chargePointCollection).doc(id).set({
        ocppConnected: false,
        status: 'Disconnected',
        disconnectedAt: FieldValue.serverTimestamp(),
      }, { merge: true }).catch((error) => console.error('Firestore disconnect write failed:', error.message));
    }
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Charging Point OCPP backend listening on ${port}`);
});
