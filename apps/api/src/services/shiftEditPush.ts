/**
 * The guard's notice that a scheduled shift's hours moved.
 *
 * Sent by PATCH /api/shifts/:id once a scheduled or unassigned shift's edit
 * commits (D20), and by the N160 DST correction (ops/n160DstCorrection.ts),
 * which moves shifts the way that edit does, so a corrected shift reaches its
 * guard with the same notification row, push and wording as an admin's edit.
 * Moved here from the route unchanged.
 *
 * Row unconditionally; the push is best-effort on top of it. A guard whose
 * shift moved needs the new time whether or not their handset has an active
 * device row. (The route's old query carried `AND fcm_token IS NOT NULL`; it
 * was redundant: getActivePushToken returns null when the guard has no active
 * device, which is exactly what the push branches on.)
 *
 * Returns the chain without a catch; callers decide. The route fires and
 * forgets after its response. The correction awaits every notice before it
 * exits, or the process would end with pushes unsent.
 */
import { insertNotification } from './notifications';
import { getActivePushToken } from './deviceRegistry';
import { sendPushNotification } from './firebase';
import { channelForType, collapseIdFor } from './pushChannels';

export function notifyShiftScheduleEdited(p: {
  guardId:  string;
  shiftId:  string;
  siteName: string;
  siteTz:   string | null;
  newStart: Date;
  newEnd:   Date;
}): Promise<unknown> {
  const tz = p.siteTz ?? 'America/Los_Angeles';
  const day = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', timeZone: tz,
  }).format(p.newStart);
  const from = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: tz,
  }).format(p.newStart);
  const to = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: tz,
  }).format(p.newEnd);

  const editTitle = `Shift time changed at ${p.siteName}`;
  const editBody  = `Now ${day}, ${from} – ${to}. Tap to view details.`;
  const editData  = {
    type: 'shift_schedule_edited',
    shift_id: p.shiftId,
    scheduled_start: p.newStart.toISOString(),
    scheduled_end:   p.newEnd.toISOString(),
  };
  return insertNotification({
    guardId: p.guardId,
    type:    'shift_schedule_edited',
    title:   editTitle,
    body:    editBody,
    data:    editData,
    shiftSessionId: null,
  })
    .then(async (notifId) => {
      const token = await getActivePushToken(p.guardId);
      if (!token) return;
      return sendPushNotification({
        token,
        title: editTitle,
        body:  editBody,
        data:  editData,
        notificationId: notifId,
        channelId:      channelForType('shift_schedule_edited'),
        collapseId:     collapseIdFor('shift_schedule_edited', { shift_id: p.shiftId }),
      });
    });
}
