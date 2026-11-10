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

export interface TemporalTrackOptions {
  /** Actual frame.native_tick, not wall time or the number of callbacks. */
  native_tick: number;
  /** Actual frame.view.applied_pose; pitch must already be valid. */
  pose: TurnOrientation;
  /** Model-selected orientation; shortest wrapped yaw and clamped target pitch. */
  target: TurnOrientation;
  /** Required positive per-axis radians/sec cap, at most 20*pi. */
  max_rate: number;
  /** Required finite positive per-axis radians/sec² cap. */
  max_acceleration: number;
  /** Required positive safe integer ticks: desired velocity = error / (response_ticks * .05). */
  response_ticks: number;
  /** Alignment reporting only, default .01 radians, in [0, pi]; never snaps velocity to zero. */
  tolerance?: number;
}

export interface TemporalTrackState {
  last_tick: number;
  /** Prior requested velocity, not an assertion that the native pose moved. */
  velocity: {
    yaw_radians_per_second: number;
    pitch_radians_per_second: number;
  };
}

export interface TemporalTrackResult {
  view: { kind: "rate"; yaw_radians_per_second: number; pitch_radians_per_second: number };
  /**
   * Explicit immutable JSON state; retain in next_state. Null or a regressed tick
   * initializes zero velocity at the current tick. Same-tick calls retain velocity,
   * even if pose/target changes. Target changes otherwise never reset velocity.
   * Invalid inputs/state throw RangeError, including prior speed above max_rate;
   * a lower cap therefore requires a fitting carried velocity or an explicit reset.
   */
  state: TemporalTrackState;
  /** Actual pose within tolerance on both axes, not completion or a zero-rate guarantee. */
  aligned: boolean;
  error: TurnOrientation;
}

export interface PureModuleMotion {
  turn(options: TemporalTurnOptions, state?: TemporalTurnState | null): TemporalTurnResult;
  /** Pure feedback math only: no target selection, timing, arrival or gameplay guarantee. */
  track(options: TemporalTrackOptions, state?: TemporalTrackState | null): TemporalTrackResult;
}
