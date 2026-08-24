export function appDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.APP_TIMEZONE || 'Pacific/Honolulu',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}
