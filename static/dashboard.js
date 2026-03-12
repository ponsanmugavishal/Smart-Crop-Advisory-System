let trendChart = null;
let autoRefreshTimer = null;
let latestHistoryRows = [];
let latestReading = null;
let latestRecommendation = null;
let socket = null;
let subscribedFieldId = null;

function t(key, fallback = '') {
  return window.i18n?.t(key, fallback) || fallback;
}

function formatTemplate(template, replacements = {}) {
  return Object.entries(replacements).reduce((result, [key, value]) => {
    return result.replaceAll(`{${key}}`, String(value));
  }, template);
}

function tr(key, fallback = '', replacements = {}) {
  return formatTemplate(t(key, fallback), replacements);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSigned(value, digits = 1) {
  if (!Number.isFinite(value)) return '--';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(digits)}`;
}

function clearRiskClasses(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.remove('is-good', 'is-warn', 'is-critical');
}

function setRisk(cardId, badgeId, level, label) {
  clearRiskClasses(cardId);
  const card = document.getElementById(cardId);
  if (card && level) {
    card.classList.add(`is-${level}`);
  }
  setText(badgeId, label || '--');
}

function classifyMetric(value, goodMin, goodMax, warnMin, warnMax) {
  if (!Number.isFinite(value)) return 'warn';
  if (value >= goodMin && value <= goodMax) return 'good';
  if (value >= warnMin && value <= warnMax) return 'warn';
  return 'critical';
}

function riskLabel(level) {
  if (level === 'good') return t('runtime.riskGood', 'Optimal');
  if (level === 'warn') return t('runtime.riskWatch', 'Watch');
  return t('runtime.riskCritical', 'Critical');
}

function irrigationImpliesWatering(action) {
  const text = String(action || '').toLowerCase();
  if (!text) return false;
  if (text.includes('pause') || text.includes('no irrigation') || text.includes('நிறுத்த') || text.includes('வேண்டாம்') || text.includes('रोकें') || text.includes('न करें')) {
    return false;
  }
  return true;
}

function renderLiveTileRisk(reading, recommendation) {
  if (!reading) {
    setRisk('moistureCard', 'moistureRisk', null, '--');
    setRisk('rainCard', 'rainRisk', null, '--');
    setRisk('tempCard', 'tempRisk', null, '--');
    setRisk('humCard', 'humRisk', null, '--');
    return;
  }

  const moistureLevel = classifyMetric(Number(reading.soil_moisture), 40, 75, 25, 85);
  const tempLevel = classifyMetric(Number(reading.temperature_c), 20, 32, 15, 35);
  const humLevel = classifyMetric(Number(reading.humidity), 40, 75, 30, 85);

  const irrigationActive = irrigationImpliesWatering(recommendation?.irrigation_action);
  const rainLevel = Number(reading.rain_detected) === 1 && irrigationActive ? 'critical' : Number(reading.rain_detected) === 1 ? 'good' : 'warn';

  setRisk('moistureCard', 'moistureRisk', moistureLevel, riskLabel(moistureLevel));
  setRisk('tempCard', 'tempRisk', tempLevel, riskLabel(tempLevel));
  setRisk('humCard', 'humRisk', humLevel, riskLabel(humLevel));
  setRisk('rainCard', 'rainRisk', rainLevel, rainLevel === 'warn' ? t('runtime.rainPending', 'Dry') : riskLabel(rainLevel));
}

function averageByWindow(rows, metricKey, startMs, endMs) {
  const subset = rows.filter((row) => {
    const ts = new Date(row.recorded_at).getTime();
    return ts >= startMs && ts < endMs;
  });

  if (!subset.length) return null;
  const total = subset.reduce((sum, row) => sum + Number(row[metricKey] || 0), 0);
  return total / subset.length;
}

async function loadComparisons(fieldId) {
  const [weekRows, seasonRows] = await Promise.all([
    fetchJson(`/api/fields/${fieldId}/history?hours=192`),
    fetchJson(`/api/fields/${fieldId}/history?hours=1440`),
  ]);

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const todayAvg = averageByWindow(weekRows, 'soil_moisture', now - dayMs, now);
  const lastWeekAvg = averageByWindow(weekRows, 'soil_moisture', now - (8 * dayMs), now - (7 * dayMs));

  const thisSeasonAvg = averageByWindow(seasonRows, 'soil_moisture', now - (30 * dayMs), now);
  const previousSeasonAvg = averageByWindow(seasonRows, 'soil_moisture', now - (60 * dayMs), now - (30 * dayMs));

  if (todayAvg === null || lastWeekAvg === null) {
    setText('todayVsWeek', t('dashboard.noComparisonData', 'Not enough data for comparison yet.'));
  } else {
    const delta = todayAvg - lastWeekAvg;
    setText(
      'todayVsWeek',
      tr('dashboard.todayVsWeekValue', 'Average moisture {delta}% vs last week ({today}% today).', {
        delta: formatSigned(delta, 1),
        today: todayAvg.toFixed(1),
      })
    );
  }

  if (thisSeasonAvg === null || previousSeasonAvg === null) {
    setText('seasonVsPrevious', t('dashboard.noSeasonData', 'More seasonal history is needed.'));
  } else {
    const delta = thisSeasonAvg - previousSeasonAvg;
    setText(
      'seasonVsPrevious',
      tr('dashboard.seasonVsPreviousValue', 'Average moisture {delta}% vs previous season ({season}% this season).', {
        delta: formatSigned(delta, 1),
        season: thisSeasonAvg.toFixed(1),
      })
    );
  }
}

function renderWeeklySummary(reading, recommendation, rows) {
  if (!reading) {
    setText('weeklySummaryIntro', t('dashboard.noSummary', 'Weekly summary will appear after new readings are available.'));
    const list = document.getElementById('weeklySummaryList');
    if (list) {
      list.innerHTML = '';
      const item = document.createElement('li');
      item.textContent = '--';
      list.appendChild(item);
    }
    return;
  }

  const now = Date.now();
  const weekStart = now - (7 * 24 * 60 * 60 * 1000);
  const weekMoistureAvg = averageByWindow(rows, 'soil_moisture', weekStart, now);
  const listItems = [];

  if (weekMoistureAvg !== null && weekMoistureAvg < 40) {
    listItems.push(tr('dashboard.checklistIrrigationUp', 'Increase irrigation frequency; 7-day average moisture is {value}%.', { value: weekMoistureAvg.toFixed(1) }));
  } else if (weekMoistureAvg !== null) {
    listItems.push(tr('dashboard.checklistIrrigationSteady', 'Keep current irrigation schedule; 7-day average moisture is stable at {value}%.', { value: weekMoistureAvg.toFixed(1) }));
  }

  if (Number(reading.temperature_c) > 34) {
    listItems.push(t('dashboard.checklistHeat', 'Check crop canopy in afternoon and prefer short cooling irrigation cycles.'));
  } else {
    listItems.push(t('dashboard.checklistTempNormal', 'Temperature is in a manageable range; keep the current watering window.'));
  }

  if (Number(reading.humidity) > 80) {
    listItems.push(t('dashboard.checklistHumidityHigh', 'Humidity is high; inspect for fungal spots and avoid overwatering tonight.'));
  } else {
    listItems.push(t('dashboard.checklistHumidityNormal', 'Humidity is balanced; continue routine monitoring for disease prevention.'));
  }

  if (recommendation?.resource_optimization_tip) {
    listItems.push(tr('dashboard.checklistResource', 'Resource focus: {tip}', { tip: recommendation.resource_optimization_tip }));
  }

  setText(
    'weeklySummaryIntro',
    tr('dashboard.summaryIntro', 'Health: {health} | Confidence: {confidence}%', {
      health: recommendation?.crop_health_status || t('runtime.unknown', 'Unknown'),
      confidence: recommendation ? (Number(recommendation.confidence_score) * 100).toFixed(0) : '--',
    })
  );

  const list = document.getElementById('weeklySummaryList');
  if (!list) return;
  list.innerHTML = '';

  listItems.slice(0, 4).forEach((content) => {
    const item = document.createElement('li');
    item.textContent = content;
    list.appendChild(item);
  });
}

function updateHealthChip(status) {
  const chip = document.getElementById('healthChip');
  if (chip) {
    chip.textContent = `${t('runtime.statusLabel', 'Status')}: ${status || '--'}`;
  }
}

function updateDetailRow(id, value) {
  setText(id, value ?? '--');
}

function getSelectedFieldLabel() {
  const fieldSelect = document.getElementById('fieldSelect');
  if (!fieldSelect) return '--';
  const selectedOption = fieldSelect.options[fieldSelect.selectedIndex];
  return selectedOption ? selectedOption.textContent : '--';
}

function updateSessionPanel() {
  const hoursSelect = document.getElementById('hoursSelect');
  const autoRefreshSelect = document.getElementById('autoRefreshSelect');
  const chartMetricSelect = document.getElementById('chartMetricSelect');
  const dataViewSelect = document.getElementById('dataViewSelect');

  const hours = hoursSelect?.value || '48';
  const autoRefresh = autoRefreshSelect?.value || '0';
  const chartFocusLabel = chartMetricSelect?.options[chartMetricSelect.selectedIndex]?.textContent || t('dashboard.focusAll', 'All Metrics');
  const dataViewLabel = dataViewSelect?.options[dataViewSelect.selectedIndex]?.textContent || 'Real-time Live';

  updateDetailRow('detailWindow', tr('dashboard.windowValue', '{hours} hours', { hours }));
  updateDetailRow('detailAutoRefresh', autoRefresh === '0' ? t('dashboard.off', 'Off') : tr('dashboard.secondsValue', '{seconds}s', { seconds: autoRefresh }));
  updateDetailRow('detailChartFocus', `${chartFocusLabel} | ${dataViewLabel}`);
}

function updateHistoryMeta(rows) {
  const count = rows.length;
  setText('historyPointCount', `${count} ${t('runtime.points', 'points')}`);
}

function removeStartupSpike(rows) {
  if (!Array.isArray(rows) || rows.length < 3) return rows;

  const first = Number(rows[0]?.soil_moisture ?? 0);
  const second = Number(rows[1]?.soil_moisture ?? 0);
  const third = Number(rows[2]?.soil_moisture ?? 0);

  const firstJump = Math.abs(first - second);
  const followupJump = Math.abs(second - third);
  const likelyStartupSpike = firstJump >= 20 && followupJump <= 6;

  if (!likelyStartupSpike) return rows;
  return rows.slice(1);
}

function clampMoistureOutliers(rows) {
  if (!Array.isArray(rows) || rows.length < 3) return rows;

  const adjusted = [rows[0]];
  for (let index = 1; index < rows.length; index += 1) {
    const prev = adjusted[index - 1];
    const current = rows[index];

    const prevMoisture = Number(prev?.soil_moisture ?? 0);
    const currentMoisture = Number(current?.soil_moisture ?? 0);
    const jump = Math.abs(currentMoisture - prevMoisture);

    if (jump > 18) {
      adjusted.push({
        ...current,
        soil_moisture: prevMoisture,
      });
    } else {
      adjusted.push(current);
    }
  }

  return adjusted;
}

function exportHistoryCsv() {
  if (!latestHistoryRows.length) {
    alert(t('runtime.noHistoryExport', 'No history data to export yet.'));
    return;
  }

  const mode = document.getElementById('dataViewSelect')?.value || 'realtime';
  const header = mode === 'daily'
    ? ['summary_date', 'avg_moisture', 'avg_temperature', 'avg_humidity', 'rain_frequency', 'generated_at']
    : ['recorded_at', 'soil_moisture', 'temperature_c', 'humidity', 'rain_detected', 'source_type'];

  const lines = latestHistoryRows.map((row) => [
    mode === 'daily' ? row.summary_date : row.recorded_at,
    mode === 'daily' ? row.avg_moisture : row.soil_moisture,
    mode === 'daily' ? row.avg_temperature : row.temperature_c,
    mode === 'daily' ? row.avg_humidity : row.humidity,
    mode === 'daily' ? row.rain_frequency : row.rain_detected,
    mode === 'daily' ? row.generated_at : row.source_type,
  ].join(','));

  const csvContent = [header.join(','), ...lines].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `smartfarm-history-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function renderLatestPanels(reading, recommendation) {
  latestReading = reading;
  latestRecommendation = recommendation;

  updateDetailRow('detailField', getSelectedFieldLabel());

  if (!reading) {
    setText('moistureVal', '-- %');
    setText('rainVal', '--');
    setText('tempVal', '-- °C');
    setText('humVal', '-- %');
    setText('lastUpdated', `${t('runtime.lastUpdated', 'Last updated')}: --`);
    updateDetailRow('detailSource', '--');
    updateDetailRow('detailRecordedAt', '--');
  } else {
    setText('moistureVal', `${reading.soil_moisture.toFixed(1)} %`);
    setText('rainVal', reading.rain_detected ? t('runtime.rainDetected', 'Rain Detected') : t('runtime.noRain', 'No Rain'));
    setText('tempVal', `${reading.temperature_c.toFixed(1)} °C`);
    setText('humVal', `${reading.humidity.toFixed(1)} %`);
    setText('lastUpdated', `${t('runtime.lastUpdated', 'Last updated')}: ${formatTime(reading.recorded_at)}`);
    updateDetailRow('detailSource', reading.source_type || '--');
    updateDetailRow('detailRecordedAt', formatTime(reading.recorded_at));
  }

  if (!recommendation) {
    updateHealthChip('--');
    updateDetailRow('detailHealth', '--');
    updateDetailRow('detailIrrigation', '--');
    updateDetailRow('detailConfidence', '--');
    setText('detailResource', `${t('suggestions.resourceTip', 'Resource Tip:')} --`);
    setText('detailSummary', `${t('suggestions.summary', 'Summary:')} --`);
  } else {
    updateHealthChip(recommendation.crop_health_status);
    updateDetailRow('detailHealth', recommendation.crop_health_status || '--');
    updateDetailRow('detailIrrigation', recommendation.irrigation_action || '--');
    updateDetailRow('detailConfidence', `${(recommendation.confidence_score * 100).toFixed(0)}%`);
    setText('detailResource', `${t('suggestions.resourceTip', 'Resource Tip:')} ${recommendation.resource_optimization_tip || '--'}`);
    setText('detailSummary', `${t('suggestions.summary', 'Summary:')} ${recommendation.generated_summary || '--'}`);
  }

  renderLiveTileRisk(reading, recommendation);
  renderWeeklySummary(latestReading, latestRecommendation, latestHistoryRows);
}

async function loadLatest(fieldId) {
  const data = await loadLatestPayload(fieldId);
  renderLatestPanels(data.latest_reading, data.latest_recommendation);
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

    renderLatestPanels(payload.latest_reading, payload.latest_recommendation);

    // Append new data point to chart in real-time without re-fetching history
    const mode = document.getElementById('dataViewSelect')?.value || 'realtime';
    if (trendChart && payload.latest_reading && mode === 'realtime') {
      const reading = payload.latest_reading;
      const label = new Date(reading.recorded_at).toLocaleString();
      const selectedMetric = document.getElementById('chartMetricSelect')?.value || 'all';

      trendChart.data.labels.push(label);

      trendChart.data.datasets.forEach((ds) => {
        if (ds.label.includes('Moisture') || ds.label.includes('moisture')) {
          ds.data.push(reading.soil_moisture);
        } else if (ds.label.includes('Temperature') || ds.label.includes('temperature') || ds.label.includes('Temp')) {
          ds.data.push(reading.temperature_c);
        } else if (ds.label.includes('Humidity') || ds.label.includes('humidity')) {
          ds.data.push(reading.humidity);
        }
      });

      // Keep chart from growing unbounded — trim oldest points beyond window
      const maxPoints = 500;
      if (trendChart.data.labels.length > maxPoints) {
        trendChart.data.labels.shift();
        trendChart.data.datasets.forEach((ds) => ds.data.shift());
      }

      trendChart.update('none'); // 'none' disables animation for instant update

      // Also update the in-memory history rows
      latestHistoryRows.push({
        recorded_at: reading.recorded_at,
        soil_moisture: reading.soil_moisture,
        temperature_c: reading.temperature_c,
        humidity: reading.humidity,
        rain_detected: reading.rain_detected,
        source_type: reading.source_type,
      });
      updateHistoryMeta(latestHistoryRows);
    }
  });
}

async function loadHistory(fieldId) {
  updateSessionPanel();

  const mode = document.getElementById('dataViewSelect')?.value || 'realtime';
  const selectedHours = document.getElementById('hoursSelect').value || '48';
  const rows = await fetchJson(`/api/fields/${fieldId}/history?hours=${selectedHours}&mode=${mode}`);
  latestHistoryRows = rows;
  const rowsForChart = mode === 'realtime' ? clampMoistureOutliers(removeStartupSpike(rows)) : rows;
  updateHistoryMeta(rowsForChart);

  const labels = rowsForChart.map((row) => {
    if (mode === 'daily') {
      return new Date(`${row.summary_date}T00:00:00`).toLocaleDateString();
    }
    return new Date(row.recorded_at).toLocaleString();
  });

  const moisture = rowsForChart.map((row) => mode === 'daily' ? row.avg_moisture : row.soil_moisture);
  const temp = rowsForChart.map((row) => mode === 'daily' ? row.avg_temperature : row.temperature_c);
  const humidity = rowsForChart.map((row) => mode === 'daily' ? row.avg_humidity : row.humidity);
  const selectedMetric = document.getElementById('chartMetricSelect')?.value || 'all';

  const datasets = [];
  if (selectedMetric === 'all' || selectedMetric === 'moisture') {
    datasets.push({
      label: t('runtime.chartMoisture', 'Soil Moisture (%)'),
      data: moisture,
      borderColor: '#00ffc3',
      backgroundColor: 'rgba(0,255,195,0.18)',
      tension: 0,
      pointRadius: 3,
      fill: false,
    });
  }

  if (selectedMetric === 'all' || selectedMetric === 'temperature') {
    datasets.push({
      label: t('runtime.chartTemperature', 'Temperature (°C)'),
      data: temp,
      borderColor: '#ff8a3d',
      backgroundColor: 'rgba(255,138,61,0.15)',
      tension: 0,
      pointRadius: 3,
      fill: false,
    });
  }

  if (selectedMetric === 'all' || selectedMetric === 'humidity') {
    datasets.push({
      label: t('runtime.chartHumidity', 'Humidity (%)'),
      data: humidity,
      borderColor: '#7c7dff',
      backgroundColor: 'rgba(124,125,255,0.15)',
      tension: 0,
      pointRadius: 3,
      fill: false,
    });
  }

  const ctx = document.getElementById('trendChart');
  if (!ctx) return;

  if (trendChart) {
    trendChart.destroy();
  }

  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: '#d6dcff',
          },
        },
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 8,
            color: '#9ba6d9',
          },
          grid: {
            color: 'rgba(130, 143, 212, 0.15)',
          },
        },
        y: {
          min: 0,
          max: 100,
          ticks: {
            stepSize: 10,
            color: '#9ba6d9',
          },
          grid: {
            color: 'rgba(130, 143, 212, 0.15)',
          },
        },
      },
    },
  });

  if (mode !== 'daily') {
    await loadComparisons(fieldId);
  }
  renderWeeklySummary(latestReading, latestRecommendation, latestHistoryRows);
}

async function refreshDashboard(fieldId) {
  await Promise.all([loadLatest(fieldId), loadHistory(fieldId)]);
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

async function initializeDashboard() {
  const fields = await loadFields('fieldSelect');
  if (!fields.length) return;

  setupRealtimeSocket();

  const fieldId = fields[0].field_id;
  subscribeToFieldRealtime(fieldId);
  await refreshDashboard(fieldId);

  document.getElementById('refreshBtn').addEventListener('click', async () => {
    const selectedField = document.getElementById('fieldSelect').value;
    await refreshDashboard(selectedField);
  });

  document.getElementById('recommendBtn').addEventListener('click', async () => {
    const selectedField = document.getElementById('fieldSelect').value;
    await runRuleSuggestion(selectedField);
    await loadLatest(selectedField);
  });

  document.getElementById('manualCheckBtn').addEventListener('click', async () => {
    const selectedField = document.getElementById('fieldSelect').value;
    await requestManualDeviceCheck(selectedField);
    alert(t('runtime.manualCheckQueued', 'Manual device check command sent to ESP32.'));

    await sleep(6000);
    await Promise.all([loadLatest(selectedField), loadHistory(selectedField)]);
  });

  document.getElementById('exportBtn').addEventListener('click', () => {
    exportHistoryCsv();
  });

  document.getElementById('fieldSelect').addEventListener('change', async (event) => {
    subscribeToFieldRealtime(event.target.value);
    await refreshDashboard(event.target.value);
  });

  document.getElementById('hoursSelect').addEventListener('change', async () => {
    const selectedField = document.getElementById('fieldSelect').value;
    await loadHistory(selectedField);
  });

  document.getElementById('chartMetricSelect').addEventListener('change', async () => {
    const selectedField = document.getElementById('fieldSelect').value;
    await loadHistory(selectedField);
  });

  document.getElementById('dataViewSelect').addEventListener('change', async () => {
    updateSessionPanel();
    const selectedField = document.getElementById('fieldSelect').value;
    await loadHistory(selectedField);
  });

  document.getElementById('autoRefreshSelect').addEventListener('change', () => {
    updateSessionPanel();
    resetAutoRefresh();
  });

  updateSessionPanel();
  resetAutoRefresh();
}

initializeDashboard().catch((err) => {
  console.error(err);
  alert(t('runtime.failedDashboard', 'Failed to load dashboard data. Check backend and database setup.'));
});

window.addEventListener('languageChanged', async () => {
  const fieldId = document.getElementById('fieldSelect')?.value;
  if (!fieldId) return;
  await Promise.all([loadLatest(fieldId), loadHistory(fieldId)]);
});
