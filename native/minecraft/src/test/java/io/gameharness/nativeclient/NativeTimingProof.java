package io.gameharness.nativeclient;

import com.google.gson.JsonObject;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Pure wire/fence/correlation proofs; live render/input hook conformance remains a native smoke. */
public final class NativeTimingProof {
  private static void require(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  public static void main(String[] ignored) {
    NativeReplyTiming replies = new NativeReplyTiming();
    replies.received(41, 9007199254740993L);
    replies.received(42, 9007199254740995L);
    JsonObject immediate = replies.replied(42, "boot", 9007199254740997L, 3);
    JsonObject delayed = replies.replied(41, "boot", 9007199254740999L, 7);
    require(immediate.getAsJsonPrimitive("received_ns").isString()
        && delayed.getAsJsonPrimitive("replied_ns").isString(), "reply ns exposed as unsafe JS numbers");
    require(immediate.get("received_ns").getAsString().equals("9007199254740995"),
        "immediate rejection lost its own receive stamp");
    require(delayed.get("received_ns").getAsString().equals("9007199254740993"),
        "delayed receipt acquired a later request's receive stamp");
    require(delayed.get("replied_ns").getAsString().equals("9007199254740999")
        && delayed.get("client_tick").getAsLong() == 7, "reply clock narrowed or sampled at receive");
    require(replies.replied(41, "boot", 100, 8) == null, "retired request timing replayed");
    replies.received(43, -500);
    require(replies.replied(43, "boot", -400, 8).get("received_ns").getAsString().equals("-500"),
        "signed nanoTime domain was rewritten");
    controllerLeaseReceipts();
    controllerApplicationReceipts();

    NativeInputTiming inputs = new NativeInputTiming();
    inputs.keySample.record(101, 4);
    inputs.keySample.record(109, 5);
    inputs.cameraApply.record(111, 5);
    inputs.keyRelease.record(117, 6);
    JsonObject evidence = inputs.evidence("boot", 41, "original-owner", 9);
    JsonObject keys = evidence.getAsJsonObject("key_sample");
    require(keys.getAsJsonPrimitive("first_ns").isString()
        && keys.getAsJsonPrimitive("last_ns").isString(), "input ns exposed as unsafe JS numbers");
    require(keys.get("first_ns").getAsString().equals("101")
        && keys.get("last_ns").getAsString().equals("109")
        && keys.get("first_client_tick").getAsLong() == 4
        && keys.get("last_client_tick").getAsLong() == 5, "first/last input sample lost");
    require(evidence.get("operation_id").getAsString().equals("original-owner")
        && evidence.get("generation").getAsLong() == 9, "cleanup release attributed to replacement owner");
    require(evidence.getAsJsonObject("key_release").get("point").getAsString()
        .equals("KeyBinding.setPressed/release"), "release claimed keyboard consumption or game confirmation");
    require(new NativeInputTiming().evidence("boot", 1, "unused", 1).get("key_sample").isJsonNull(),
        "missing input sampling fabricated a timestamp");

    NativeRenderSnapshot snapshot = new NativeRenderSnapshot();
    snapshot.begin();
    snapshot.positionMatrix[0] = 2;
    snapshot.positionMatrix[15] = 1;
    snapshot.projectionMatrix[0] = 3;
    snapshot.projectionMatrix[15] = 1;
    snapshot.sample(500, 8, 12, 1.25, 2.5, -3.75, 0, .5f, 0, .866f, .2, .3, .625);
    ByteBuffer frame = ByteBuffer.allocate(328).order(ByteOrder.LITTLE_ENDIAN);
    snapshot.header(frame, 640, 480, 17, 1234, 600, 14, 8, 12, 19, null);
    require(frame.position() == 328 && frame.getInt(0) == 0x47485632, "GHV2 payload offset incorrect");
    require(frame.getLong(48) == 500 && frame.getLong(64) == 1 && frame.getInt(312) == 1,
        "same-invocation snapshot omitted");
    require(frame.getDouble(96) == 1.25 && frame.getFloat(152) == 2
        && frame.getFloat(216) == 3 && frame.getDouble(320) == .625,
        "actual camera/matrix/tick-delta values not copied to wire offsets");
    snapshot.finished(frame, 650);
    require(frame.getLong(32) == 600 && frame.getLong(40) == 650, "readback completion overwrote start");
    snapshot.begin();
    snapshot.header(frame.clear(), 640, 480, 18, 1235, 700, 15, 8, 12, 19, null);
    require(frame.getInt(312) == 0 && frame.getLong(48) == 0 && frame.getDouble(96) == 0,
        "previous invocation camera relabelled as a fresh world render");
    snapshot.sample(710, 8, 12, 4, 5, 6, 0, 0, 0, 1, .4, .5, .75);
    snapshot.header(frame.clear(), 640, 480, 19, 1236, 720, 16, 9, 12, 19, null);
    require(frame.getInt(312) == 0, "life mismatch survived snapshot fence");
    snapshot.header(frame.clear(), 640, 480, 19, 1236, 720, 16, 8, 13, 19, null);
    require(frame.getInt(312) == 0, "space mismatch survived snapshot fence");
    snapshot.invalidate();
    snapshot.header(frame.clear(), 640, 480, 19, 1236, 720, 16, 8, 12, 19,
        new EffectAuthority.Screen("00112233-4455-6677-8899-aabbccddeeff", 5, 6));
    require(frame.getInt(312) == 2 && frame.getLong(280) == 0x0011223344556677L
        && frame.getLong(288) == 0x8899aabbccddeeffL && frame.getLong(296) == 5
        && frame.getLong(304) == 6, "tail screen identity absent or confused with world snapshot");
    snapshot.sample(800, 8, 12, 4, 5, 6, 0, 0, 0, 1, .4, .5, .75);
    snapshot.header(frame.clear(), 640, 480, 20, 1237, 799, 17, 8, 12, 19, null);
    require(frame.getInt(312) == 0, "future world-render timestamp admitted");
    snapshot.end();
    snapshot.sample(810, 8, 12, 4, 5, 6, 0, 0, 0, 1, .4, .5, .75);
    snapshot.header(frame.clear(), 640, 480, 20, 1237, 820, 17, 8, 12, 19, null);
    require(frame.getInt(312) == 0, "closed render invocation accepted world snapshot");
    snapshot.begin();
    snapshot.sample(830, 8, 12, Double.NaN, 5, 6, 0, 0, 0, 1, .4, .5, .75);
    snapshot.header(frame.clear(), 640, 480, 21, 1238, 840, 18, 8, 12, 19, null);
    require(frame.getInt(312) == 0 && frame.getDouble(96) == 0, "nonfinite camera exposed as valid");
    snapshot.positionMatrix[7] = Float.POSITIVE_INFINITY;
    snapshot.sample(830, 8, 12, 4, 5, 6, 0, 0, 0, 1, .4, .5, .75);
    snapshot.header(frame.clear(), 640, 480, 21, 1238, 840, 18, 8, 12, 19, null);
    require(frame.getInt(312) == 0 && frame.getFloat(180) == 0, "nonfinite matrix leaked through missing-world zeros");
    boolean unsafeRejected = false;
    try {
      snapshot.header(frame.clear(), 640, 480, 21, 1238, 840,
          ContractIdentity.MAX_SAFE + 1, 8, 12, 19, null);
    } catch (IllegalArgumentException expected) { unsafeRejected = true; }
    require(unsafeRejected, "unsafe client callback counter entered GHV2");
  }
  private static void controllerApplicationReceipts() {
    // Delayed replies must retain their own signed stage snapshot, not a later owner/entry.
    var owner = new EffectAuthority.Owner("application-owner", new EffectAuthority.Scope("session", "world", 1,
        "boot", "run", 2, 3, 4, "execution", "a".repeat(64)), 5);
    long origin = -9_007_199_254_740_993L;
    var check = new ControllerInputQueue.ApplicationCheck(9, 19, origin + 1, 2, 7, 4,
        origin + 3, 10, 6, 1, origin + 4, 0, 0, origin + 8, 11);
    var replies = new NativeReplyTiming();
    replies.received(80, origin);
    replies.received(81, origin + 1);
    replies.controllerApplication(80, owner, 3, check);
    require(!replies.replied(81, "boot", origin + 9, 12).has("controller_application"),
        "unrelated reply borrowed application timing");
    var application = replies.replied(80, "boot", origin + 10, 13).getAsJsonObject("controller_application");
    require(application.get("owner").equals(NativeControllerContract.owner(owner))
        && application.get("controller_generation").getAsLong() == 3
        && application.get("sequence").getAsLong() == 9 && application.get("frame_seq").getAsLong() == 19,
        "delayed application timing lost its exact entry owner");
    require(application.get("admitted_native_ns").getAsString().equals("-9007199254740992")
        && application.get("began_native_ns").getAsString().equals("-9007199254740990")
        && application.get("prepared_native_ns").getAsString().equals("-9007199254740989")
        && application.get("settled_native_ns").getAsString().equals("-9007199254740985")
        && application.get("consumed_native_ns").isJsonNull()
        && application.get("sampled_native_ns").isJsonNull(),
        "application stage ns narrowed, resampled or fabricated for a missing hook");
    require(application.get("pending_ahead").getAsInt() == 2
        && application.get("applying_ahead_sequence").getAsLong() == 7
        && application.get("admitted_preparation_ordinal").getAsLong() == 4
        && application.get("began_preparation_ordinal").getAsLong() == 6
        && application.get("began_native_tick").getAsLong() == 10
        && application.get("settled_native_tick").getAsLong() == 11,
        "queue/preparation evidence replaced by reply tick or current occupancy");
    boolean absentRejected = false;
    try { replies.controllerApplication(999, owner, 3, check); }
    catch (IllegalStateException expected) { absentRejected = true; }
    require(absentRejected && replies.replied(999, "boot", origin + 1, 0) == null,
        "application timing attachment created an unreceived request");
  }
  private static void controllerLeaseReceipts() {
    // Catches cross-request/owner borrowing, lease/application conflation and later-state sampling.
    var owner = new EffectAuthority.Owner("lease-owner", new EffectAuthority.Scope("session", "world", 1,
        "boot", "run", 2, 3, 4, "execution", "a".repeat(64)), 5);
    long origin = -9_007_199_254_740_993L;
    var queue = new ControllerInputQueue(origin + 300_000_000L, origin);
    var replies = new NativeReplyTiming();
    replies.received(50, origin);
    replies.controllerLease(50, owner, 7, queue.opened(origin));
    replies.received(51, origin + 1);
    replies.received(52, origin + 2);
    replies.controllerLease(52, owner, 7, queue.heartbeat(origin + 300_000_000L, origin + 100_000_000L));
    queue.retired("native_neutralization", origin + 150_000_000L);
    JsonObject ordinary = replies.replied(51, "boot", origin + 160_000_000L, 9);
    require(!ordinary.has("controller_lease"), "unrelated request borrowed controller lease");
    JsonObject opening = replies.replied(50, "boot", origin + 170_000_000L, 10);
    JsonObject lease = opening.getAsJsonObject("controller_lease");
    require(opening.get("schema_version").getAsInt() == 1 && lease.get("schema_version").getAsInt() == 1
        && lease.get("event").getAsString().equals("open") && lease.get("accepted").getAsBoolean(),
        "additive diagnostic changed timing version or opening event");
    require(lease.get("owner").equals(NativeControllerContract.owner(owner))
        && lease.get("controller_generation").getAsLong() == 7, "lease identity changed with later owner/state");
    require(lease.get("checked_native_ns").getAsString().equals("-9007199254740993")
        && lease.get("effective_deadline_native_ns").getAsString().equals("-9007199004740993")
        && lease.get("task_deadline_native_ns").getAsString().equals("-9007198954740993")
        && lease.get("requested_deadline_native_ns").isJsonNull()
        && lease.get("previous_deadline_native_ns").isJsonNull()
        && lease.get("first_fence_reason").isJsonNull()
        && lease.get("first_fence_native_ns").isJsonNull()
        && lease.get("retirement_trigger").isJsonNull()
        && lease.get("retirement_native_ns").isJsonNull(), "opening facts resampled or signed long strings narrowed");
    require(!lease.has("applied_native_ns") && !lease.has("applied_native_tick"),
        "lease check masqueraded as actual input application");
    var renewal = replies.replied(52, "boot", origin + 180_000_000L, 11).getAsJsonObject("controller_lease");
    require(renewal.get("event").getAsString().equals("renew")
        && renewal.get("previous_deadline_native_ns").getAsString().equals("-9007199004740993")
        && renewal.get("effective_deadline_native_ns").getAsString().equals("-9007198954740993")
        && renewal.get("first_fence_reason").isJsonNull(), "renewal borrowed later retirement or opening deadline");
    boolean absentRejected = false;
    try { replies.controllerLease(999, owner, 7, queue.opened(origin)); }
    catch (IllegalStateException expected) { absentRejected = true; }
    require(absentRejected && replies.replied(999, "boot", origin + 1, 0) == null,
        "lease attachment fabricated timing for an unreceived request");
  }
}
