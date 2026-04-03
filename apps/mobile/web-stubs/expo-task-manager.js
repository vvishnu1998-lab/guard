/**
 * Web stub for expo-task-manager.
 * Background tasks are not supported in browsers — all calls are no-ops.
 * The locationBackground task simply won't register on web.
 */

export function defineTask(_taskName, _taskExecutor) {
  // No-op on web
}

export async function isTaskRegisteredAsync(_taskName) {
  return false;
}

export async function getRegisteredTasksAsync() {
  return [];
}

export async function unregisterAllTasksAsync() {}

export async function unregisterTaskAsync(_taskName) {}

export function isTaskDefined(_taskName) {
  return false;
}
