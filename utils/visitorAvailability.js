const ARGENTINA_TIME_ZONE = 'America/Argentina/Buenos_Aires';

function getEffectiveVisitorStatus(user, now = new Date()) {
  const manualStatus = user?.visitorStatus || 'available';
  if (manualStatus !== 'available') return manualStatus;

  const schedule = Array.isArray(user?.visitorSchedule) ? user.visitorSchedule : [];
  if (schedule.length === 0) return 'available';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ARGENTINA_TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    .indexOf(parts.find((part) => part.type === 'weekday')?.value || '');
  const current = `${parts.find((part) => part.type === 'hour')?.value || '00'}:${parts.find((part) => part.type === 'minute')?.value || '00'}`;
  const today = schedule.find((item) => item.day === weekday);

  return today?.enabled && current >= today.start && current <= today.end ? 'available' : 'off_hours';
}

module.exports = { ARGENTINA_TIME_ZONE, getEffectiveVisitorStatus };
