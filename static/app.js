let trendChart = null;
let autoRefreshTimer = null;

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || `Request failed: ${res.status}`);
  }
  return res.json();
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function formatTime(value) {
  return new Date(value).toLocaleString();
}

function updateHealthChip(status) {
  const chip = document.getElementById('healthChip');
  chip.textContent = `Status: ${status || '--'}`;
}

async function loadFields() {
  const fields = await fetchJson('/api/farmer/fields');
  const select = document.getElementById('fieldSelect');
  select.innerHTML = '';

  fields.forEach((f) => {
    const option = document.createElement('option');
    option.value = f.field_id;
    option.textContent = `${f.field_name} (${f.location_label || 'Unknown'})`;
    select.appendChild(option);
  });

  if (fields.length > 0) {
    await refreshDashboard(fields[0].field_id);
  }
}

async function loadLatest(fieldId) {
  const data = await fetchJson(`/api/fields/${fieldId}/latest`);
  const r = data.latest_reading;

  if (!r) {
    setText('moistureVal', '-- %');
    setText('rainVal', '--');
    setText('tempVal', '-- °C');
    setText('humVal', '-- %');
    setText('lastUpdated', 'Last updated: --');
  } else {
    setText('moistureVal', `${r.soil_moisture.toFixed(1)} %`);
    setText('rainVal', r.rain_detected ? 'Rain Detected' : 'No Rain');
    setText('tempVal', `${r.temperature_c.toFixed(1)} °C`);
    setText('humVal', `${r.humidity.toFixed(1)} %`);
    setText('lastUpdated', `Last updated: ${formatTime(r.recorded_at)}`);
  }

  const rec = data.latest_recommendation;
  if (!rec) {
    setText('healthStatus', '--');
    setText('irrigationAction', '--');
    setText('resourceTip', '--');
    setText('confidence', '--');
    setText('summary', '--');
    updateHealthChip('--');
  } else {
    setText('healthStatus', rec.crop_health_status);
    setText('irrigationAction', rec.irrigation_action);
    setText('resourceTip', rec.resource_optimization_tip);
    setText('confidence', `${(rec.confidence_score * 100).toFixed(0)}%`);
    setText('summary', rec.generated_summary);
    updateHealthChip(rec.crop_health_status);
  }
}

async function loadHistory(fieldId) {
  const selectedHours = document.getElementById('hoursSelect').value || '48';
  const rows = await fetchJson(`/api/fields/${fieldId}/history?hours=${selectedHours}`);

  const labels = rows.map((r) => new Date(r.recorded_at).toLocaleString());
  const moisture = rows.map((r) => r.soil_moisture);
  const temp = rows.map((r) => r.temperature_c);
  const humidity = rows.map((r) => r.humidity);

  const ctx = document.getElementById('trendChart');

  if (trendChart) trendChart.destroy();

  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Soil Moisture (%)',
          data: moisture,
          borderColor: '#2f8f46',
          backgroundColor: 'rgba(47,143,70,0.1)',
          tension: 0.25,
          fill: false,
        },
        {
          label: 'Temperature (°C)',
          data: temp,
          borderColor: '#e67e22',
          backgroundColor: 'rgba(230,126,34,0.1)',
          tension: 0.25,
          fill: false,
        },
        {
          label: 'Humidity (%)',
          data: humidity,
          borderColor: '#3498db',
          backgroundColor: 'rgba(52,152,219,0.1)',
          tension: 0.25,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { maxTicksLimit: 8 } },
      },
    },
  });
}

async function refreshDashboard(fieldId) {
  await generateRecommendation(fieldId, true);
  await Promise.all([loadLatest(fieldId), loadHistory(fieldId)]);
}

async function generateRecommendation(fieldId, silent = false) {
  await fetchJson(`/api/fields/${fieldId}/recommend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  if (!silent) {
    await loadLatest(fieldId);
  }
}

function resetAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  const seconds = Number(document.getElementById('autoRefreshSelect').value || 0);
  if (seconds > 0) {
    autoRefreshTimer = setInterval(async () => {
      const fieldId = document.getElementById('fieldSelect').value;
      if (fieldId) {
        await refreshDashboard(fieldId);
      }
    }, seconds * 1000);
  }
}

document.getElementById('refreshBtn').addEventListener('click', async () => {
  const fieldId = document.getElementById('fieldSelect').value;
  await refreshDashboard(fieldId);
});

document.getElementById('recommendBtn').addEventListener('click', async () => {
  const fieldId = document.getElementById('fieldSelect').value;
  await generateRecommendation(fieldId);
  await loadLatest(fieldId);
});

document.getElementById('fieldSelect').addEventListener('change', async (e) => {
  await refreshDashboard(e.target.value);
});

document.getElementById('hoursSelect').addEventListener('change', async () => {
  const fieldId = document.getElementById('fieldSelect').value;
  if (fieldId) {
    await loadHistory(fieldId);
  }
});

document.getElementById('autoRefreshSelect').addEventListener('change', () => {
  resetAutoRefresh();
});

loadFields().catch((err) => {
  console.error(err);
  alert('Failed to load dashboard data. Check backend and database setup.');
});

resetAutoRefresh();
