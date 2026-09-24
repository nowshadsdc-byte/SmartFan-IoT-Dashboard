// Device config validation rules (shared by REST routes and the dashboard form).
// Mirrored inline in mini-services/iot-hub/index.ts — keep in sync.

export interface ConfigInput {
  tempOn: number;
  tempOff: number;
  heartbeatIntervalSec: number;
}

export type ConfigErrors = Partial<Record<keyof ConfigInput, string>>;

/** Rules: 0 <= tempOff < tempOn <= 60, tempOn - tempOff >= 1, 5 <= heartbeatIntervalSec <= 300 (integer). */
export function validateConfig(c: ConfigInput): ConfigErrors {
  const errors: ConfigErrors = {};
  const { tempOn, tempOff, heartbeatIntervalSec } = c;
  if (typeof tempOn !== "number" || !Number.isFinite(tempOn)) {
    errors.tempOn = "tempOn must be a number";
  } else if (tempOn > 60) {
    errors.tempOn = "tempOn must be at most 60 °C";
  }
  if (typeof tempOff !== "number" || !Number.isFinite(tempOff)) {
    errors.tempOff = "tempOff must be a number";
  } else if (tempOff < 0) {
    errors.tempOff = "tempOff must be at least 0 °C";
  }
  if (!errors.tempOn && !errors.tempOff) {
    if (tempOff >= tempOn) {
      errors.tempOff = "tempOff must be lower than tempOn";
    } else if (tempOn - tempOff < 1) {
      errors.tempOn = "tempOn must be at least 1 °C above tempOff";
    }
  }
  if (
    typeof heartbeatIntervalSec !== "number" ||
    !Number.isInteger(heartbeatIntervalSec) ||
    heartbeatIntervalSec < 5 ||
    heartbeatIntervalSec > 300
  ) {
    errors.heartbeatIntervalSec = "heartbeatIntervalSec must be a whole number between 5 and 300";
  }
  return errors;
}

export function describeConfigErrors(errors: ConfigErrors): string {
  return Object.values(errors).join("; ");
}
