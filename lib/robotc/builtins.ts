import { BOOL, CType, FLOAT, INT, LONG, STRING, VOID } from "./ast";

/** Named constants every RobotC NXT program can use. */
export const BUILTIN_CONSTANTS: Record<string, { value: number; ty: CType }> = {
  true: { value: 1, ty: BOOL },
  false: { value: 0, ty: BOOL },
  NULL: { value: 0, ty: INT },
  PI: { value: Math.PI, ty: FLOAT },
  motorA: { value: 0, ty: INT },
  motorB: { value: 1, ty: INT },
  motorC: { value: 2, ty: INT },
  S1: { value: 0, ty: INT },
  S2: { value: 1, ty: INT },
  S3: { value: 2, ty: INT },
  S4: { value: 3, ty: INT },
  T1: { value: 0, ty: INT },
  T2: { value: 1, ty: INT },
  T3: { value: 2, ty: INT },
  T4: { value: 3, ty: INT },
  kNoButton: { value: -1, ty: INT },
  kExitButton: { value: 0, ty: INT },
  kRightButton: { value: 1, ty: INT },
  kLeftButton: { value: 2, ty: INT },
  kEnterButton: { value: 3, ty: INT },
  soundBlip: { value: 0, ty: INT },
  soundBeepBeep: { value: 1, ty: INT },
  soundDownwardTones: { value: 2, ty: INT },
  soundUpwardTones: { value: 3, ty: INT },
  soundLowBuzz: { value: 4, ty: INT },
  soundFastUpwardTones: { value: 5, ty: INT },
  soundShortBlip: { value: 6, ty: INT },
  soundException: { value: 7, ty: INT },
  soundLowBuzzShort: { value: 8, ty: INT },
};

export interface BuiltinVar {
  ty: CType;
  /** Length if this is an array such as motor[] or time1[]. */
  length?: number;
  writable: boolean;
}

/** Built-in variables the simulator models. */
export const BUILTIN_VARS: Record<string, BuiltinVar> = {
  nVolume: { ty: INT, writable: true },
  bSoundActive: { ty: BOOL, writable: false },
  bSoundQueueAvailable: { ty: BOOL, writable: false },
  nNxtButtonPressed: { ty: INT, writable: false },
  nSysTime: { ty: LONG, writable: false },
  nPgmTime: { ty: LONG, writable: false },
  nAvgBatteryLevel: { ty: INT, writable: false },
  nImmediateBatteryLevel: { ty: INT, writable: false },
  bNxtLCDStatusDisplay: { ty: BOOL, writable: true },
  time1: { ty: INT, length: 4, writable: true },
  time10: { ty: INT, length: 4, writable: true },
  time100: { ty: INT, length: 4, writable: true },
  motor: { ty: INT, length: 3, writable: true },
  nMotorEncoder: { ty: LONG, length: 3, writable: true },
  nMotorEncoderTarget: { ty: LONG, length: 3, writable: true },
  SensorValue: { ty: INT, length: 4, writable: true },
  SensorRaw: { ty: INT, length: 4, writable: false },
  SensorType: { ty: INT, length: 4, writable: true },
};

export interface BuiltinFunc {
  min: number;
  max: number;
  /** Return type; "arg" means the same type as the first argument (abs). */
  ret: CType | "arg";
  /** True if the call can pause the task (waits, yields). */
  pauses?: boolean;
  /** True if the argument names a task rather than being a value. */
  taskArg?: boolean;
}

const fn = (min: number, max: number, ret: CType | "arg", extra: Partial<BuiltinFunc> = {}): BuiltinFunc => ({
  min, max, ret, ...extra,
});

const DISPLAY = fn(1, 12, VOID);

export const BUILTIN_FUNCS: Record<string, BuiltinFunc> = {
  // Sound
  PlayTone: fn(2, 2, VOID),
  playTone: fn(2, 2, VOID),
  PlayImmediateTone: fn(2, 2, VOID),
  playImmediateTone: fn(2, 2, VOID),
  ClearSounds: fn(0, 0, VOID),
  clearSounds: fn(0, 0, VOID),
  PlaySound: fn(1, 1, VOID),
  playSound: fn(1, 1, VOID),
  PlaySoundFile: fn(1, 1, VOID),
  playSoundFile: fn(1, 1, VOID),
  // Timing
  wait1Msec: fn(1, 1, VOID, { pauses: true }),
  wait10Msec: fn(1, 1, VOID, { pauses: true }),
  sleep: fn(1, 1, VOID, { pauses: true }),
  delay: fn(1, 1, VOID, { pauses: true }),
  wait: fn(0, 2, VOID, { pauses: true }),
  ClearTimer: fn(1, 1, VOID),
  clearTimer: fn(1, 1, VOID),
  resetTimer: fn(1, 1, VOID),
  EndTimeSlice: fn(0, 0, VOID, { pauses: true }),
  abortTimeslice: fn(0, 0, VOID, { pauses: true }),
  hogCPU: fn(0, 0, VOID),
  releaseCPU: fn(0, 0, VOID),
  // Tasks
  StartTask: fn(1, 2, VOID, { taskArg: true }),
  startTask: fn(1, 2, VOID, { taskArg: true }),
  StopTask: fn(1, 1, VOID, { taskArg: true }),
  stopTask: fn(1, 1, VOID, { taskArg: true }),
  StopAllTasks: fn(0, 0, VOID),
  stopAllTasks: fn(0, 0, VOID),
  // Math
  random: fn(1, 1, INT),
  rand: fn(0, 0, INT),
  srand: fn(1, 1, VOID),
  abs: fn(1, 1, "arg"),
  sgn: fn(1, 1, INT),
  sqrt: fn(1, 1, FLOAT),
  sin: fn(1, 1, FLOAT),
  cos: fn(1, 1, FLOAT),
  tan: fn(1, 1, FLOAT),
  asin: fn(1, 1, FLOAT),
  acos: fn(1, 1, FLOAT),
  atan: fn(1, 1, FLOAT),
  atan2: fn(2, 2, FLOAT),
  exp: fn(1, 1, FLOAT),
  log: fn(1, 1, FLOAT),
  log10: fn(1, 1, FLOAT),
  pow: fn(2, 2, FLOAT),
  floor: fn(1, 1, FLOAT),
  ceil: fn(1, 1, FLOAT),
  round: fn(1, 1, INT),
  sinDegrees: fn(1, 1, FLOAT),
  cosDegrees: fn(1, 1, FLOAT),
  degreesToRadians: fn(1, 1, FLOAT),
  radiansToDegrees: fn(1, 1, FLOAT),
  // Display
  nxtDisplayTextLine: DISPLAY,
  nxtDisplayCenteredTextLine: DISPLAY,
  nxtDisplayBigTextLine: DISPLAY,
  nxtDisplayCenteredBigTextLine: DISPLAY,
  nxtDisplayString: DISPLAY,
  nxtDisplayClearTextLine: fn(1, 1, VOID),
  displayTextLine: DISPLAY,
  displayCenteredTextLine: DISPLAY,
  displayBigTextLine: DISPLAY,
  displayCenteredBigTextLine: DISPLAY,
  displayString: DISPLAY,
  displayClearTextLine: fn(1, 1, VOID),
  eraseDisplay: fn(0, 0, VOID),
  // Debug stream (shown in the simulator console)
  writeDebugStream: fn(1, 12, VOID),
  writeDebugStreamLine: fn(1, 12, VOID),
  clearDebugStream: fn(0, 0, VOID),
  // Strings
  strlen: fn(1, 1, INT),
};

export const STRING_TYPE = STRING;
