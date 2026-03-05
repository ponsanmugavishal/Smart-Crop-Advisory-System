async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || `Request failed: ${res.status}`);
  }
  return res.json();
}

function t(key, fallback = '') {
  return window.i18n?.t(key, fallback) || fallback;
}

function getCurrentLanguage() {
  return window.i18n?.getLanguage?.() || 'en';
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
  }
}

function formatTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString();
}

async function loadFields(selectId = 'fieldSelect') {
  const fields = await fetchJson('/api/farmer/fields');
  const select = document.getElementById(selectId);
  if (!select) return [];

  select.innerHTML = '';
  fields.forEach((field) => {
    const option = document.createElement('option');
    option.value = field.field_id;
    option.textContent = `${field.field_name} (${field.location_label || t('runtime.unknown', 'Unknown')})`;
    select.appendChild(option);
  });

  return fields;
}

async function loadLatestPayload(fieldId) {
  const lang = encodeURIComponent(getCurrentLanguage());
  return fetchJson(`/api/fields/${fieldId}/latest?lang=${lang}`);
}

async function runRuleSuggestion(fieldId) {
  const lang = getCurrentLanguage();
  return fetchJson(`/api/fields/${fieldId}/recommend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang }),
  });
}

async function requestManualDeviceCheck(fieldId) {
  return fetchJson('/api/device/manual-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field_id: Number(fieldId) }),
  });
}
