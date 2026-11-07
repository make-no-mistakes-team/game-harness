/** The synchronous realm-local `motion` binding in step/analyze modules. No game capability. */
export interface TurnOrientation {
  yaw_radians: number;
  pitch_radians: number;
}

export interface TemporalTurnOptions {
  /** Actual frame.native_tick, not wall time or the number of step callbacks. */
  native_tick: number;
  /** Actual frame.view.applied_pose, never the last requested pose. */
  pose: TurnOrientation;
  /** Model-selected orientation. Yaw wraps shortest-path; pitch clamps to its valid range. */
  target: TurnOrientation;
  /** Model-selected positive integer simulation ticks; no default turn duration. */
  duration_ticks: number;
  /** Model-selected radians/sec cap per axis, in (0, 20*pi]. */
  max_rate: number;
  /** Actual-pose alignment tolerance in radians, default 0.01, in [0, pi]. */
  tolerance?: number;
}

export interface TemporalTurnState {
  start_tick: number;
  last_tick: number;
  origin: TurnOrientation;
  target: TurnOrientation;
  duration_ticks: number;
}

export interface TemporalTurnResult {
  view: { kind: "rate"; yaw_radians_per_second: number; pitch_radians_per_second: number };
  /** Explicit JSON state to retain in next_state and supply on the next call. */
  state: TemporalTurnState;
  /** Authored native-tick duration exhausted, whether or not the actual pose aligned. */
  finished: boolean;
  /** Current actual pose is within tolerance on both axes, independent of finished. */
  aligned: boolean;
  error: TurnOrientation;
}

export interface PureModuleMotion {
  turn(options: TemporalTurnOptions, state?: TemporalTurnState | null): TemporalTurnResult;
}
