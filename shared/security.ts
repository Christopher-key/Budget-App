// Public service status contains no incident details, identities or budget data.
export const LOCKDOWN_MESSAGE = 'Access is temporarily paused while we review a security alert. This lockdown does not erase your budget records.';
export const SECURITY_UNAVAILABLE_MESSAGE = 'Access is temporarily paused because the service security status could not be verified.';
export interface PublicServiceStatus {
  schemaVersion: 1;
  state: 'open' | 'locked' | 'unavailable';
  generation: number;
}
// Private control metadata, stored apart from the budget app's host storage.
export interface LockdownControl {
  schemaVersion: 1;
  locked: boolean;
  generation: number;
  updatedAt: string;
  reason: 'initialization' | 'manual' | 'verified-alert' | 'recovery';
  incidentId: string | null;
  review: 'none' | 'pending' | 'confirmed' | 'false-positive' | 'remediated';
  handledAlertHashes: string[];
}
export interface SecurityGate {
  check(expectedGeneration?: number): Promise<number>;
  status(): Promise<PublicServiceStatus>;
}
