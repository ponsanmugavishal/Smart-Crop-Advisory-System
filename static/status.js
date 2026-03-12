function t(key, fallback = '') {
  return window.i18n?.t(key, fallback) || fallback;
}

function tr(templateKey, fallback, replacements = {}) {
  const template = t(templateKey, fallback);
  return Object.entries(replacements).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template
  );
}

let busy = false;
let autoRefreshTimer = null;
const STATUS_AUTO_REFRESH_MS = 5000;
let socket = null;
let subscribedFieldId = null;

function setActionStatus(text) {
  setText('statusActionStatus', text || '--');
}

function setBusyState(isBusy) {
  ['refreshBtn', 'fieldSelect'].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.disabled = isBusy;
  });
}

async function runWithBusy(action, loadingText) {
  if (busy) return;
  busy = true;
  setBusyState(true);
  setActionStatus(loadingText || t('status.loading', 'Updating status...'));

  try {
    await action();
  } catch (error) {
    console.error(error);
    setActionStatus(t('runtime.failedStatus', 'Failed to load status data. Check backend and database setup.'));
    alert(t('runtime.failedStatus', 'Failed to load status data. Check backend and database setup.'));
  } finally {
    busy = false;
    setBusyState(false);
  }
}

function deriveIrrigationState(action) {
  const value = (action || '').toLowerCase();
  if (
    value.includes('pause') ||
    value.includes('no irrigation') ||
    value.includes('நிறுத்த') ||
    value.includes('வேண்டாம்') ||
    value.includes('रोकें') ||
    value.includes('न करें')
  ) {
    return t('runtime.irrigationPaused', 'Paused');
  }
  if (value.includes('immediately') || value.includes('உடனே') || value.includes('तुरंत')) {
    return t('runtime.irrigationUrgent', 'Urgent');
  }
  if (value.includes('short') || value.includes('குறுகிய') || value.includes('छोटा')) {
    return t('runtime.irrigationShort', 'Short Cycle');
  }
  if (value.includes('maintain') || value.includes('தொடர') || value.includes('बनाए रखें')) {
    return t('runtime.irrigationScheduled', 'Scheduled');
  }
  return '--';
}

function mapEsp32Status(value) {
  if (value === 'online') return t('status.esp32Online', 'Online');
  if (value === 'delayed') return t('status.esp32Delayed', 'Delayed');
  if (value === 'offline') return t('status.esp32Offline', 'Offline');
  return t('status.esp32NoData', 'No Data');
}

function mapSourceType(source) {
  if (source === 'realtime') return t('status.sourceRealtime', 'Realtime');
  if (source === 'scheduled') return t('status.sourceScheduled', 'Scheduled');
  return '--';
}

function mapQueueState(pending) {
  return pending ? t('status.queuePending', 'Pending') : t('status.queueEmpty', 'Empty');
}

function setFieldChip(health) {
  setText('fieldStatusChip', `${t('status.fieldHealth', 'Field Health')}: ${health || '--'}`);
}

function setEsp32Chip(status) {
  setText('esp32Chip', `${t('status.esp32Connection', 'Connection')}: ${status || '--'}`);
}

function renderEmpty() {
  setText('statusHealth', '--');
  setText('statusIrrigation', '--');
  setText('statusMoisture', '--');
  setText('statusTemp', '--');
  setText('statusHumidity', '--');
  setText('statusRain', '--');
  setText('statusReadingTime', '--');
  setText('esp32Connection', '--');
  setText('esp32LastSeen', '--');
  setText('esp32Source', '--');
  setText('esp32Queue', '--');
  setText('statusSummary', t('status.noStatus', 'No status available.'));
  setText('statusRefreshInfo', '--');
  setFieldChip('--');
  setEsp32Chip('--');
}

function renderStatusFromPayload(latestPayload, devicePayload) {
  const reading = latestPayload.latest_reading;
  const recommendation = latestPayload.latest_recommendation;

  if (!reading && !recommendation) {
    renderEmpty();
    return;
  }

  const health = recommendation?.crop_health_status || '--';
  const irrigation = deriveIrrigationState(recommendation?.irrigation_action);

  setText('statusHealth', health);
  setText('statusIrrigation', irrigation);
  setText('statusMoisture', reading ? `${Number(reading.soil_moisture).toFixed(1)}%` : '--');
  setText('statusTemp', reading ? `${Number(reading.temperature_c).toFixed(1)}°C` : '--');
  setText('statusHumidity', reading ? `${Number(reading.humidity).toFixed(1)}%` : '--');
  setText(
    'statusRain',
    reading
      ? Number(reading.rain_detected) === 1
        ? t('runtime.rainDetected', 'Rain Detected')
        : t('runtime.noRain', 'No Rain')
      : '--'
  );
  setText('statusReadingTime', reading ? formatTime(reading.recorded_at) : '--');

  const esp32Status = mapEsp32Status(devicePayload.esp32_status);
  setText('esp32Connection', esp32Status);
  setText('esp32LastSeen', devicePayload.last_seen ? formatTime(devicePayload.last_seen) : '--');
  setText('esp32Source', mapSourceType(devicePayload.latest_source_type));
  setText('esp32Queue', mapQueueState(Boolean(devicePayload.command_pending)));

  setFieldChip(health);
  setEsp32Chip(esp32Status);

  const minutesSinceLastSeen = devicePayload.minutes_since_last_seen;
  setText(
    'statusRefreshInfo',
    Number.isFinite(Number(minutesSinceLastSeen))
      ? tr('status.refreshInfo', 'Device last reported {minutes} minutes ago.', {
          minutes: Number(minutesSinceLastSeen),
        })
      : t('status.refreshInfoNoData', 'Device has not reported data yet.')
  );

  const summary = recommendation?.generated_summary || t('status.noStatus', 'No status available.');
  setText('statusSummary', summary);
}

async function loadStatus(fieldId) {
  const [latestPayload, devicePayload] = await Promise.all([
    loadLatestPayload(fieldId),
    fetchJson(`/api/device/status?field_id=${encodeURIComponent(fieldId)}`),
  ]);

  renderStatusFromPayload(latestPayload, devicePayload);
}

async function refreshStatus(fieldId) {
  await loadStatus(fieldId);
}

async function autoRefreshStatus() {
  const fieldId = document.getElementById('fieldSelect')?.value;
  if (!fieldId || busy) return;

  try {
    await loadStatus(fieldId);
    setActionStatus(
      tr('runtime.lastUpdated', 'Last updated: {time}', {
        time: new Date().toLocaleTimeString(),
      })
    );
  } catch (error) {
    console.error(error);
    setActionStatus(t('runtime.failedStatus', 'Failed to load status data. Check backend and database setup.'));
  }
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(autoRefreshStatus, STATUS_AUTO_REFRESH_MS);
}

function subscribeToFieldRealtime(fieldId) {
  if (!socket || !fieldId) return;

  if (subscribedFieldId && Number(subscribedFieldId) !== Number(fieldId)) {
    socket.emit('unsubscribe_field', { field_id: Number(subscribedFieldId) });
  }

  subscribedFieldId = Number(fieldId);
  socket.emit('subscribe_field', { field_id: Number(fieldId) });
}

function setupRealtimeSocket() {
  if (!window.io) return;

  socket = window.io();
  socket.on('connect', () => {
    const selectedField = document.getElementById('fieldSelect')?.value;
    if (selectedField) subscribeToFieldRealtime(selectedField);
  });

  socket.on('sensor_update', (payload) => {
    const selectedField = Number(document.getElementById('fieldSelect')?.value || 0);
    if (!payload || Number(payload.field_id) !== selectedField) return;
    renderStatusFromPayload(payload, payload.device_status || {});
    setActionStatus(
      tr('runtime.lastUpdated', 'Last updated: {time}', {
        time: new Date().toLocaleTimeString(),
      })
    );
  });
}

async function initializeStatus() {
  const fields = await loadFields('fieldSelect');
  if (!fields.length) return;

  const fieldId = fields[0].field_id;
  await refreshStatus(fieldId);
  setActionStatus(t('status.statusReady', 'Status is ready.'));
  setupRealtimeSocket();
  subscribeToFieldRealtime(fieldId);
  startAutoRefresh();

  document.getElementById('refreshBtn').addEventListener('click', async () => {
    const selectedField = document.getElementById('fieldSelect').value;
    await runWithBusy(async () => {
      await refreshStatus(selectedField);
      setActionStatus(t('status.statusRefreshed', 'Status refreshed successfully.'));
    }, t('status.loading', 'Updating status...'));
  });

  document.getElementById('fieldSelect').addEventListener('change', async (event) => {
    await runWithBusy(async () => {
      await refreshStatus(event.target.value);
      setActionStatus(t('status.statusFieldUpdated', 'Field switched and status updated.'));
    }, t('status.loadingField', 'Loading selected field status...'));
    subscribeToFieldRealtime(event.target.value);
    startAutoRefresh();
  });
}

initializeStatus().catch((err) => {
  console.error(err);
  alert(t('runtime.failedStatus', 'Failed to load status data. Check backend and database setup.'));
});

window.addEventListener('languageChanged', async () => {
  const fieldId = document.getElementById('fieldSelect')?.value;
  if (!fieldId) return;
  await runWithBusy(async () => {
    await loadStatus(fieldId);
    setActionStatus(t('status.statusLanguageUpdated', 'Language updated.'));
  }, t('status.loadingLanguage', 'Refreshing localized status...'));
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    startAutoRefresh();
    autoRefreshStatus();
    return;
  }

  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
});
