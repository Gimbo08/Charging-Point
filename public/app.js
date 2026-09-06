import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';

const firebaseConfig = window.CHARGING_POINT_FIREBASE_CONFIG || {
  apiKey: 'AIzaSyBvxH5ukbGMA3mVsEmR1UPAw-D4RhosuC8',
  authDomain: 'charging-point-b58f4.firebaseapp.com',
  projectId: 'charging-point-b58f4',
  storageBucket: 'charging-point-b58f4.firebasestorage.app',
  messagingSenderId: '485797330874',
  appId: '1:485797330874:web:ea8dbcc355e98042caa783'
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const apiBase = window.CHARGING_POINT_API_BASE || 'https://charging-point-ocpp-485797330874.europe-west8.run.app';
const connectionTimeoutMs = 120000;
const $ = (id) => document.getElementById(id);

function setVisible(id, visible) { $(id).classList.toggle('hidden', !visible); }
function setMessage(text, error = false) { $('actionMessage').textContent = text; $('actionMessage').className = error ? 'message error' : 'message'; }
function setCommandAvailability(connected) {
  $('applyButton').disabled = !connected;
  $('startButton').disabled = !connected;
  $('stopButton').disabled = !connected;
  $('modeBadge').textContent = connected ? 'OCPP connesso' : 'OCPP non connesso';
  $('modeBadge').classList.toggle('offline', !connected);
}
function formatPower(values) { const value = values?.find((item) => item.measurand === 'Power.Active.Import')?.value; return value ? `${Number(value).toFixed(0)} W` : '—'; }
function formatCurrent(values) { const value = values?.find((item) => item.measurand === 'Current.Offered')?.value; return value ? `${value} A` : '—'; }
function formatSessionEnergy(energyWh) { return Number.isFinite(Number(energyWh)) ? `${(Number(energyWh) / 1000).toFixed(2)} kWh` : '0.00 kWh'; }

async function api(path, options = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Sessione scaduta');
  const token = await user.getIdToken();
  const response = await fetch(`${apiBase}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Errore ${response.status}`);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function refresh() {
  try {
    const data = await api('/api/charge-points');
    const point = data[0];
    if (!point) {
      $('status').textContent = 'Non connessa';
      setCommandAvailability(false);
      return;
    }
    const lastSeenMs = point.lastSeenAt ? Date.parse(point.lastSeenAt) : NaN;
    const recentlySeen = Number.isFinite(lastSeenMs) && (Date.now() - lastSeenMs) <= connectionTimeoutMs;
    const connected = point.ocppConnected === true && recentlySeen;
    setCommandAvailability(connected);
    const reportedStatus = point.status || (connected ? 'Connessa' : 'Non connessa');
    const actualPower = Number(point.measuredPowerW);
    const effectiveStatus = reportedStatus === 'Charging' && (!Number.isFinite(actualPower) || actualPower <= 10)
      ? 'In attesa energia'
      : reportedStatus;
    $('status').textContent = effectiveStatus;
    $('model').textContent = `${point.vendor || ''} ${point.model || ''}`;
    $('lastSeen').textContent = point.lastSeenAt ? `Ultimo dato: ${new Date(point.lastSeenAt).toLocaleString('it-IT')}` : '—';
    if (!recentlySeen) setMessage('Connessione OCPP non confermata da oltre 120 secondi.', true);
    $('power').textContent = formatPower(point.meterValues?.at(-1)?.sampledValue);
    $('current').textContent = formatCurrent(point.meterValues?.at(-1)?.sampledValue);
    $('sessionEnergy').textContent = formatSessionEnergy(point.sessionEnergyWh);
    if (point.manualMode?.currentLimitA) { $('amps').value = point.manualMode.currentLimitA; $('ampsValue').textContent = point.manualMode.currentLimitA; }
  } catch (error) { setMessage(error.message, true); }
}

$('loginButton').addEventListener('click', async () => {
  $('loginError').textContent = '';
  try { await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value); } catch (error) { $('loginError').textContent = 'Accesso non riuscito. Controlla email e password.'; }
});
$('logout').addEventListener('click', () => signOut(auth));
$('amps').addEventListener('input', (event) => { $('ampsValue').textContent = event.target.value; });
async function chargingAction(action) {
  $('startButton').disabled = true; $('stopButton').disabled = true; setMessage(action === 'start' ? 'Avvio ricarica…' : 'Arresto ricarica…');
  try {
    const result = await api('/api/charging-action', { method: 'POST', body: JSON.stringify({ action }) });
    setMessage(result.message || `Risposta wallbox: ${result.responseStatus || 'ricevuta'}.`, !result.ok);
    await refresh();
  }
  catch (error) { setMessage(error.message, true); }
  finally { $('startButton').disabled = false; $('stopButton').disabled = false; }
}
$('startButton').addEventListener('click', () => chargingAction('start'));
$('stopButton').addEventListener('click', () => chargingAction('stop'));
$('applyButton').addEventListener('click', async () => {
  $('applyButton').disabled = true; setMessage('Invio comando…');
  try {
    const local = $('expires').value;
    const expiresAt = local ? new Date(local).toISOString() : undefined;
    await api('/api/manual-mode', { method: 'POST', body: JSON.stringify({ currentLimitA: Number($('amps').value), ...(expiresAt ? { expiresAt } : {}) }) });
    $('modeBadge').textContent = 'Manuale'; setMessage('Corrente applicata alla wallbox.'); await refresh();
  } catch (error) { setMessage(error.message, true); } finally { $('applyButton').disabled = false; }
});
onAuthStateChanged(auth, (user) => { setVisible('login', !user); setVisible('dashboard', Boolean(user)); setVisible('logout', Boolean(user)); if (user) { refresh(); setInterval(refresh, 15000); } });
