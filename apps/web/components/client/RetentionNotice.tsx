'use client';

interface Props {
  daysRemaining?: number; // only shown if site has passed day 60
}

export default function RetentionNotice({ daysRemaining }: Props) {
  if (!daysRemaining || daysRemaining > 30) return null;

  const isUrgent = daysRemaining <= 10;

  return (
    <div className={`border rounded-xl p-4 flex items-start gap-3 ${
      isUrgent ? 'border-red-500 bg-red-950' : 'border-yellow-500 bg-yellow-950'
    }`}>
      <span className="text-2xl">{isUrgent ? '🚨' : '⚠️'}</span>
      <div>
        <p className={`font-bold text-sm tracking-widest ${isUrgent ? 'text-red-400' : 'text-yellow-400'}`}>
          DATA DELETION IN {daysRemaining} DAYS
        </p>
        <p className="text-gray-300 text-sm mt-1">
          Your site data will be permanently deleted in {daysRemaining} days.
          Please download all reports you wish to keep before access is disabled.
        </p>
        <a href="/client/download" className={`text-sm mt-2 inline-block underline ${isUrgent ? 'text-red-300' : 'text-yellow-300'}`}>
          Download Reports Now
        </a>
      </div>
    </div>
  );
}
