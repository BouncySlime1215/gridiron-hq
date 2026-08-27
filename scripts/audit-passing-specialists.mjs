import { passingSpecialistAudit } from '../server/services/nfl-passing-specialists.js';

const result = passingSpecialistAudit();
console.log(JSON.stringify(result, null, 2));
