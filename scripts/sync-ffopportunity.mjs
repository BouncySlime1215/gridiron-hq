import { syncFfOpportunity, ffOpportunityStatus } from '../server/services/ffopportunity.js';

const requested = process.argv.slice(2).map(Number).filter(Number.isInteger);
const seasons = requested.length ? requested : [2022, 2023, 2024, 2025];
console.log(JSON.stringify(await syncFfOpportunity(seasons), null, 2));
console.log(JSON.stringify(ffOpportunityStatus(), null, 2));
