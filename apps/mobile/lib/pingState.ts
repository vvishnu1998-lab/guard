/**
 * Module-level ping state — survives component remounts and navigation.
 * Used to suppress the "PING DUE" alert for the rest of a cycle after
 * the guard manually submits a ping.
 */
export const pingState = {
  /** Epoch ms. Alert is suppressed while Date.now() < suppressAlertUntil */
  suppressAlertUntil: 0,
};
