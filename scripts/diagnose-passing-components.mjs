#!/usr/bin/env node
import { passingComponentDiagnostic } from '../server/services/nfl-passing-diagnostic.js';

const seasons = process.argv.slice(2).map(Number).filter(Number.isFinite);
const report = passingComponentDiagnostic(seasons.length ? seasons : [2022, 2023, 2024, 2025],
  { useCache: false });
console.log(JSON.stringify(report, null, 2));

