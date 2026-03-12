function t(key, fallback = '') {
  return window.i18n?.t(key, fallback) || fallback;
}

let busy = false;

function formatTemplate(template, replacements = {}) {
  return Object.entries(replacements).reduce((result, [key, value]) => {
    return result.replaceAll(`{${key}}`, String(value));
  }, template);
}

function tr(key, fallback = '', replacements = {}) {
  return formatTemplate(t(key, fallback), replacements);
}

function setChecklist(items) {
  const list = document.getElementById('actionChecklist');
  if (!list) return;

  list.innerHTML = '';
  if (!items.length) {
    const item = document.createElement('li');
    item.textContent = '--';
    list.appendChild(item);
    return;
  }

  items.forEach((content) => {
    const item = document.createElement('li');
    item.textContent = content;
    list.appendChild(item);
  });
}

function setImprovementList(items) {
  const list = document.getElementById('improvementList');
  if (!list) return;

  list.innerHTML = '';
  if (!items.length) {
    const item = document.createElement('li');
    item.textContent = '--';
    list.appendChild(item);
    return;
  }

  items.forEach((content) => {
    const item = document.createElement('li');
    item.textContent = content;
    list.appendChild(item);
  });
}

function setActionStatus(text) {
  setText('suggestionActionStatus', text || '--');
}

function setButtonsBusyState(isBusy) {
  ['refreshBtn', 'recommendBtn', 'improveBtn', 'fieldSelect'].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.disabled = isBusy;
  });
}

async function runWithBusy(action, loadingText) {
  if (busy) return;
  busy = true;
  setButtonsBusyState(true);
  setActionStatus(loadingText || t('common.refreshNow', 'Refreshing...'));

  try {
    await action();
  } catch (error) {
    console.error(error);
    setActionStatus(t('runtime.failedSuggestions', 'Failed to load suggestions. Check backend and database setup.'));
    alert(t('runtime.failedSuggestions', 'Failed to load suggestions. Check backend and database setup.'));
  } finally {
    busy = false;
    setButtonsBusyState(false);
  }
}

function classifySuggestionRisk(reading) {
  if (!reading) return 'warn';

  const moisture = Number(reading.soil_moisture);
  const temperature = Number(reading.temperature_c);
  const humidity = Number(reading.humidity);

  let points = 0;
  if (moisture < 25 || moisture > 85) points += 2;
  else if (moisture < 35 || moisture > 75) points += 1;

  if (temperature > 35 || temperature < 14) points += 2;
  else if (temperature > 32 || temperature < 18) points += 1;

  if (humidity > 85 || humidity < 28) points += 1;

  if (points >= 4) return 'critical';
  if (points >= 2) return 'watch';
  return 'good';
}

function riskLabel(level) {
  if (level === 'good') return t('runtime.riskGood', 'Optimal');
  if (level === 'critical') return t('runtime.riskCritical', 'Critical');
  return t('runtime.riskWatch', 'Watch');
}

function determinePriority(riskLevel, confidenceScore) {
  if (riskLevel === 'critical') return t('suggestions.priorityHigh', 'High');
  if (riskLevel === 'watch' || confidenceScore < 0.8) return t('suggestions.priorityMedium', 'Medium');
  return t('suggestions.priorityLow', 'Low');
}

function determineNextCheck(riskLevel) {
  if (riskLevel === 'critical') return t('suggestions.nextCheckSoon', 'Within 30 minutes');
  if (riskLevel === 'watch') return t('suggestions.nextCheckModerate', 'Within 1 hour');
  return t('suggestions.nextCheckLater', 'Within 2-3 hours');
}

function buildChecklist(reading, recommendation) {
  const checklist = [];
  const actionText = String(recommendation?.irrigation_action || '').toLowerCase();

  if (Number(reading?.rain_detected) === 1 && !actionText.includes('no irrigation') && !actionText.includes('pause')) {
    checklist.push(t('suggestions.checkNoRainWithIrrigation', 'Rain is detected, so avoid immediate irrigation and verify runoff.'));
  }

  if (Number(reading?.soil_moisture) < 30) {
    checklist.push(t('suggestions.checkLowMoisture', 'Soil moisture is low; prioritize this field for the next irrigation cycle.'));
  }

  if (Number(reading?.temperature_c) > 34) {
    checklist.push(t('suggestions.checkHighTemp', 'High temperature detected; prefer early-morning watering to reduce evaporation.'));
  }

  if (Number(reading?.humidity) > 80) {
    checklist.push(t('suggestions.checkHighHumidity', 'Humidity is high; inspect for fungal signs before increasing water.'));
  }

  if (!checklist.length) {
    checklist.push(t('suggestions.checkStable', 'Field conditions are stable; continue current schedule and monitor routinely.'));
  }

  return checklist.slice(0, 4);
}

function buildImprovementSuggestions(reading, recommendation) {
  const improvements = [];
  const moisture = Number(reading?.soil_moisture);
  const temp = Number(reading?.temperature_c);
  const humidity = Number(reading?.humidity);
  const rain = Number(reading?.rain_detected);
  const confidence = Number(recommendation?.confidence_score || 0);

  if (Number.isFinite(moisture) && moisture < 35) {
    improvements.push(t('suggestions.improveLowMoisture', 'Install drip or pulse irrigation scheduling to stabilize low soil moisture.'));
  }
  if (Number.isFinite(moisture) && moisture > 75) {
    improvements.push(t('suggestions.improveHighMoisture', 'Improve drainage channels and avoid long watering cycles to prevent root stress.'));
  }
  if (Number.isFinite(temp) && temp > 34) {
    improvements.push(t('suggestions.improveHighTemp', 'Shift watering window to early morning and add mulching to reduce evaporation loss.'));
  }
  if (Number.isFinite(humidity) && humidity > 80) {
    improvements.push(t('suggestions.improveHighHumidity', 'Increase plant spacing or airflow checks to lower fungal disease risk under high humidity.'));
  }
  if (rain === 1) {
    improvements.push(t('suggestions.improveRainAware', 'Enable rain-aware auto-skip so irrigation is paused automatically during rainfall.'));
  }
  if (confidence < 0.8) {
    improvements.push(t('suggestions.improveConfidence', 'Improve confidence by collecting more frequent sensor readings and calibrating sensors weekly.'));
  }

  if (!improvements.length) {
    improvements.push(t('suggestions.improveStable', 'Current setup looks stable; keep weekly sensor calibration and review trends every 48 hours.'));
  }

  return improvements.slice(0, 5);
}

function buildDetailedInsights(reading, recommendation, riskLevel, priority) {
  if (!reading || !recommendation) {
    return {
      overview: '--',
      moisture: '--',
      weather: '--',
      plan: '--',
    };
  }

  const moisture = Number(reading.soil_moisture);
  const temp = Number(reading.temperature_c);
  const humidity = Number(reading.humidity);
  const rain = Number(reading.rain_detected);

  let moistureBand = t('suggestions.moistureBandStable', 'stable');
  if (moisture < 30) moistureBand = t('suggestions.moistureBandCriticalLow', 'critical low');
  else if (moisture < 40) moistureBand = t('suggestions.moistureBandBelowTarget', 'below target');
  else if (moisture > 75) moistureBand = t('suggestions.moistureBandHigh', 'high');

  const overview = tr(
    'suggestions.detailOverviewTpl',
    'Field condition is {risk} with {priority} priority. Current recommendation suggests: {action}',
    {
      risk: riskLabel(riskLevel),
      priority,
      action: recommendation.irrigation_action,
    }
  );

  const moistureImpact =
    moisture < 35
      ? t('suggestions.detailMoistureImpactLow', 'the root zone may not hold enough water for the next cycle, so timely irrigation is important.')
      : moisture > 75
      ? t('suggestions.detailMoistureImpactHigh', 'excess water retention risk, so avoid additional watering and improve drainage.')
      : t('suggestions.detailMoistureImpactNormal', 'acceptable moisture balance for steady crop health.');

  const moistureInsight = tr(
    'suggestions.detailMoistureTpl',
    'Soil moisture is {moisture}% ({band}). This indicates {impact}',
    {
      moisture: moisture.toFixed(1),
      band: moistureBand,
      impact: moistureImpact,
    }
  );

  const weatherImpact =
    temp > 34
      ? t('suggestions.detailWeatherImpactHeat', 'can increase evapotranspiration and should be managed with cooler-time irrigation windows.')
      : humidity > 80
      ? t('suggestions.detailWeatherImpactHumidity', 'can increase fungal pressure, so water volume should be conservative.')
      : t('suggestions.detailWeatherImpactNormal', 'is currently manageable with regular monitoring.');

  const weatherInsight = tr(
    'suggestions.detailWeatherTpl',
    'Temperature is {temp}°C and humidity is {humidity}% with {rainSignal}. This combination {impact}',
    {
      temp: temp.toFixed(1),
      humidity: humidity.toFixed(1),
      rainSignal: rain === 1
        ? t('suggestions.detailRainActive', 'active rain signal')
        : t('suggestions.detailRainNone', 'no rain signal'),
      impact: weatherImpact,
    }
  );

  const firstStep =
    rain === 1
      ? t('suggestions.detailPlanRain', 'Pause immediate irrigation, validate runoff and recheck moisture after 2-3 hours.')
      : moisture < 35
      ? t('suggestions.detailPlanLowMoisture', 'Run a controlled irrigation cycle now and verify moisture response within 60 minutes.')
      : t('suggestions.detailPlanStable', 'Maintain current schedule and monitor next reading cycle.');

  const actionPlan = tr(
    'suggestions.detailPlanTpl',
    '{firstStep} Then follow resource tip: {tip}',
    {
      firstStep,
      tip: recommendation.resource_optimization_tip,
    }
  );

  return {
    overview,
    moisture: moistureInsight,
    weather: weatherInsight,
    plan: actionPlan,
  };
}

function renderFallbackState() {
  setText('healthStatus', '--');
  setText('irrigationAction', '--');
  setText('resourceTip', '--');
  setText('confidence', '--');
  setText('summary', t('runtime.noRecommendation', 'No recommendation available for this field yet.'));
  setText('suggestionRisk', '--');
  setText('priorityLevel', '--');
  setText('nextCheck', '--');
  setText('generatedAt', '--');
  setText('moistureNow', '--');
  setText('tempNow', '--');
  setText('humidityNow', '--');
  setText('rainNow', '--');
  setChecklist([]);
  setImprovementList([]);
  setText('insightOverview', '--');
  setText('moistureInsight', '--');
  setText('weatherInsight', '--');
  setText('actionPlanInsight', '--');
}

async function loadSuggestion(fieldId) {
  const data = await loadLatestPayload(fieldId);
  const recommendation = data.latest_recommendation;
  const reading = data.latest_reading;

  if (!recommendation) {
    renderFallbackState();
    return;
  }

  const riskLevel = classifySuggestionRisk(reading);
  const confidenceScore = Number(recommendation.confidence_score || 0);

  setText('healthStatus', recommendation.crop_health_status);
  setText('irrigationAction', recommendation.irrigation_action);
  setText('resourceTip', recommendation.resource_optimization_tip);
  setText('confidence', `${(confidenceScore * 100).toFixed(0)}%`);
  setText('summary', recommendation.generated_summary);
  setText('suggestionRisk', riskLabel(riskLevel));
  const priority = determinePriority(riskLevel, confidenceScore);
  setText('priorityLevel', priority);
  setText('nextCheck', determineNextCheck(riskLevel));
  setText('generatedAt', formatTime(recommendation.generated_at));

  if (reading) {
    setText('moistureNow', `${Number(reading.soil_moisture).toFixed(1)}%`);
    setText('tempNow', `${Number(reading.temperature_c).toFixed(1)}°C`);
    setText('humidityNow', `${Number(reading.humidity).toFixed(1)}%`);
    setText('rainNow', Number(reading.rain_detected) === 1 ? t('runtime.rainDetected', 'Rain Detected') : t('runtime.noRain', 'No Rain'));
  } else {
    setText('moistureNow', '--');
    setText('tempNow', '--');
    setText('humidityNow', '--');
    setText('rainNow', '--');
  }

  setChecklist(buildChecklist(reading, recommendation));
  setImprovementList(buildImprovementSuggestions(reading, recommendation));

  const details = buildDetailedInsights(reading, recommendation, riskLevel, priority);
  setText('insightOverview', details.overview);
  setText('moistureInsight', details.moisture);
  setText('weatherInsight', details.weather);
  setText('actionPlanInsight', details.plan);
}

let socket = null;
let subscribedFieldId = null;

function renderSuggestionFromPayload(recommendation, reading) {
  if (!recommendation) {
    renderFallbackState();
    return;
  }

  const riskLevel = classifySuggestionRisk(reading);
  const confidenceScore = Number(recommendation.confidence_score || 0);

  setText('healthStatus', recommendation.crop_health_status);
  setText('irrigationAction', recommendation.irrigation_action);
  setText('resourceTip', recommendation.resource_optimization_tip);
  setText('confidence', `${(confidenceScore * 100).toFixed(0)}%`);
  setText('summary', recommendation.generated_summary);
  setText('suggestionRisk', riskLabel(riskLevel));
  const priority = determinePriority(riskLevel, confidenceScore);
  setText('priorityLevel', priority);
  setText('nextCheck', determineNextCheck(riskLevel));
  setText('generatedAt', formatTime(recommendation.generated_at));

  if (reading) {
    setText('moistureNow', `${Number(reading.soil_moisture).toFixed(1)}%`);
    setText('tempNow', `${Number(reading.temperature_c).toFixed(1)}°C`);
    setText('humidityNow', `${Number(reading.humidity).toFixed(1)}%`);
    setText('rainNow', Number(reading.rain_detected) === 1 ? t('runtime.rainDetected', 'Rain Detected') : t('runtime.noRain', 'No Rain'));
  } else {
    setText('moistureNow', '--');
    setText('tempNow', '--');
    setText('humidityNow', '--');
    setText('rainNow', '--');
  }

  setChecklist(buildChecklist(reading, recommendation));
  setImprovementList(buildImprovementSuggestions(reading, recommendation));

  const details = buildDetailedInsights(reading, recommendation, riskLevel, priority);
  setText('insightOverview', details.overview);
  setText('moistureInsight', details.moisture);
  setText('weatherInsight', details.weather);
  setText('actionPlanInsight', details.plan);
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
    renderSuggestionFromPayload(payload.latest_recommendation, payload.latest_reading);
    setActionStatus(
      formatTemplate(t('runtime.lastUpdated', 'Last updated: {time}'), {
        time: new Date().toLocaleTimeString(),
      })
    );
  });
}

async function refreshSuggestion(fieldId) {
  await runRuleSuggestion(fieldId);
  await loadSuggestion(fieldId);
}

async function initializeSuggestions() {
  const fields = await loadFields('fieldSelect');
  if (!fields.length) return;

  setupRealtimeSocket();

  const fieldId = fields[0].field_id;
  subscribeToFieldRealtime(fieldId);
  await refreshSuggestion(fieldId);
  setActionStatus(t('suggestions.statusReady', 'Ready'));

  document.getElementById('refreshBtn').addEventListener('click', async () => {
    const selectedField = document.getElementById('fieldSelect').value;
    await runWithBusy(async () => {
      await loadSuggestion(selectedField);
      setActionStatus(t('suggestions.statusRefreshed', 'Suggestion refreshed successfully.'));
    }, t('suggestions.loadingRefresh', 'Refreshing latest suggestion...'));
  });

  document.getElementById('recommendBtn').addEventListener('click', async () => {
    const selectedField = document.getElementById('fieldSelect').value;
    await runWithBusy(async () => {
      await refreshSuggestion(selectedField);
      setActionStatus(t('suggestions.statusGenerated', 'New AI suggestion generated.'));
    }, t('suggestions.loadingGenerate', 'Generating new suggestion...'));
  });

  document.getElementById('improveBtn').addEventListener('click', async () => {
    const selectedField = document.getElementById('fieldSelect').value;
    await runWithBusy(async () => {
      await loadSuggestion(selectedField);
      setActionStatus(t('suggestions.statusImproved', 'Improvement suggestions updated.'));
    }, t('suggestions.loadingImprove', 'Analyzing improvements...'));
  });

  document.getElementById('fieldSelect').addEventListener('change', async (event) => {
    subscribeToFieldRealtime(event.target.value);
    await runWithBusy(async () => {
      await refreshSuggestion(event.target.value);
      setActionStatus(t('suggestions.statusFieldUpdated', 'Field changed and suggestions updated.'));
    }, t('suggestions.loadingField', 'Updating selected field...'));
  });
}

initializeSuggestions().catch((err) => {
  console.error(err);
  alert(t('runtime.failedSuggestions', 'Failed to load suggestions. Check backend and database setup.'));
});

window.addEventListener('languageChanged', async () => {
  const fieldId = document.getElementById('fieldSelect')?.value;
  if (!fieldId) return;
  await runWithBusy(async () => {
    await loadSuggestion(fieldId);
    setActionStatus(t('suggestions.statusLanguageUpdated', 'Language updated.'));
  }, t('suggestions.loadingLanguage', 'Refreshing localized content...'));
});
