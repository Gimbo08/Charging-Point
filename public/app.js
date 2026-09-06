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

const themes = ['fluo-dark', 'fluo-light', 'green-dark', 'green-light', 'pastel-dark', 'pastel-light'];
const themeStyles = {
  'fluo-dark': {'--bg':'#10151c','--surface':'#151d26','--surface-2':'#1b2630','--text':'#f5fff8','--muted':'#a8bac4','--border':'#344553','--accent':'#adff2f','--accent-2':'#37f6ff'},
  'fluo-light': {'--bg':'#f4fff8','--surface':'#ffffff','--surface-2':'#ecfff5','--text':'#101a17','--muted':'#4c665c','--border':'#b7ef3a','--accent':'#8ed100','--accent-2':'#00bcd4'},
  'green-dark': {'--bg':'#09251d','--surface':'#12382c','--surface-2':'#174b3a','--text':'#effff5','--muted':'#a7cbb6','--border':'#4c9c76','--accent':'#8ee6ae','--accent-2':'#d7f59f'},
  'green-light': {'--bg':'#eaf4ed','--surface':'#f9fffa','--surface-2':'#e1f2e6','--text':'#17372d','--muted':'#638273','--border':'#a7ccb5','--accent':'#19734e','--accent-2':'#2e9b68'},
  'pastel-dark': {'--bg':'#29243a','--surface':'#3b334e','--surface-2':'#4a3d61','--text':'#fff8ff','--muted':'#d0c4dd','--border':'#bba7d1','--accent':'#f2b8c2','--accent-2':'#c9b3f0'},
  'pastel-light': {'--bg':'#f4eff8','--surface':'#fffaff','--surface-2':'#eee5f7','--text':'#332d4b','--muted':'#8b819b','--border':'#d6c7e5','--accent':'#8064a8','--accent-2':'#c56f91'},
};
const themeLabels = {
  'fluo-dark': 'Fluo scuro',
  'fluo-light': 'Fluo chiaro',
  'green-dark': 'Green scuro',
  'green-light': 'Green chiaro',
  'pastel-dark': 'Pastello scuro',
  'pastel-light': 'Pastello chiaro',
};
function applyTheme(theme) {
  const selected = themes.includes(theme) ? theme : 'fluo-dark';
  document.documentElement.dataset.theme = selected;
  Object.entries(themeStyles[selected]).forEach(([property, value]) => document.documentElement.style.setProperty(property, value));
  document.documentElement.style.setProperty('--button', themeStyles[selected]['--accent']);
  document.documentElement.style.setProperty('--button-text', selected.endsWith('light') ? '#ffffff' : '#111');
  document.documentElement.style.setProperty('--danger', selected.endsWith('light') ? '#c83e55' : '#ff7180');
  const palette = selected.split('-')[0];
  const mode = selected.endsWith('light') ? 'light' : 'dark';
  $('themeToggle').textContent = mode === 'light' ? '☀️' : '🌙';
  $('themeToggle').setAttribute('aria-label', `Tema ${mode === 'light' ? 'chiaro' : 'scuro'}`);
  $('themeToggle').title = `Tema ${mode === 'light' ? 'chiaro' : 'scuro'}`;
  $('paletteToggle').setAttribute('aria-label', `Palette ${palette}`);
  $('paletteToggle').title = `Palette ${palette}`;
  localStorage.setItem('charging-point-theme', selected);
}

applyTheme(localStorage.getItem('charging-point-theme') || 'fluo-dark');
$('paletteToggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme;
  const mode = current.endsWith('light') ? 'light' : 'dark';
  const palettes = ['fluo', 'green', 'pastel'];
  const nextPalette = palettes[(palettes.indexOf(current.split('-')[0]) + 1) % palettes.length];
  applyTheme(`${nextPalette}-${mode}`);
});
$('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme;
  const palette = current.split('-')[0];
  applyTheme(`${palette}-${current.endsWith('light') ? 'dark' : 'light'}`);
});

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
function italianLocalToIso(localValue) {
  if (!localValue) return undefined;
  const [datePart, timePart] = localValue.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const intendedUtc = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(intendedUtc)).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]));
  const displayedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return new Date(intendedUtc - (displayedAsUtc - intendedUtc)).toISOString();
}

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
    const isCharging = Number.isFinite(actualPower) && actualPower > 10;
    const effectiveStatus = reportedStatus === 'Charging' && !isCharging
      ? 'In attesa energia'
      : reportedStatus;
    $('status').textContent = effectiveStatus;
    $('powerDisplay').classList.toggle('charging-active', isCharging);
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
    const local = $('expires').value;
    const expiresAt = local ? italianLocalToIso(local) : undefined;
    const body = { action, ...(action === 'start' ? { currentLimitA: Number($('amps').value), ...(expiresAt ? { expiresAt } : {}) } : {}) };
    const result = await api('/api/charging-action', { method: 'POST', body: JSON.stringify(body) });
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
    const expiresAt = local ? italianLocalToIso(local) : undefined;
    await api('/api/manual-mode', { method: 'POST', body: JSON.stringify({ currentLimitA: Number($('amps').value), ...(expiresAt ? { expiresAt } : {}) }) });
    $('modeBadge').textContent = 'Manuale'; setMessage('Corrente applicata alla wallbox.'); await refresh();
  } catch (error) { setMessage(error.message, true); } finally { $('applyButton').disabled = false; }
});
onAuthStateChanged(auth, (user) => { setVisible('login', !user); setVisible('dashboard', Boolean(user)); setVisible('logout', Boolean(user)); if (user) { refresh(); setInterval(refresh, 15000); } });
