#!/usr/bin/env node
/** Chronological NFL anytime-TD calibration audit and production fit. */
import { propReplayRows } from '../server/services/nfl-props.js';
import { auditTdCalibration } from '../server/services/nfl-prop-calibration.js';

const replay = seasons => propReplayRows(seasons, { reconciliationStrength: 0, useCache: false }).rows;
const result = auditTdCalibration({
  trainRows: replay([2022, 2023]),
  discoveryRows: replay([2024]),
  validationRows: replay([2025]),
  persist: true
});
console.log(JSON.stringify(result, null, 2));
if (!result.validation_passed) process.exitCode = 2;
