package io.gameharness.survival;

import java.util.ArrayList;
import java.util.List;

/** One optional offer per failed-work incident. Only verified local effects advance a plan. */
final class AgentSituationalRecovery {
    private static final int OFFER_TICKS = 800, RECEIPT_TICKS = 120;
    static final AgentExpedition.Option NEW_GROUND = new AgentExpedition.Option("relocate_visible",
        "Try a short departure away from the failed work. Walk only on fresh, visible dry footing; this does not promise an exit.");
    static final AgentExpedition.Option RETURN = new AgentExpedition.Option("retreat_walked",
        "Turn back toward a recent walked dry crossing, then retreat only if that crossing still checks out.");
    static final AgentExpedition.Option PASSAGE = new AgentExpedition.Option("clear_side_passage",
        "Check a seen side opening around the low ceiling. Clear only a safe unprotected face and walk only if a dry landing is proved.");

    record Receipt(String advice, long incident, String method, String outcome, int completed, int total, String detail) {}

    private final ArrayList<String> failures = new ArrayList<>(5);
    private long incident, until, receiptUntil;
    private boolean opened;
    private AgentExpedition.Offer offer;
    private AgentExpedition.RecoveryPlan plan;
    private int completed;
    private boolean started;
    private String activity, adviceId;
    private ArrayList<Receipt> receipts;

    void reset() {
        incident = until = receiptUntil = 0;
        opened = started = false;
        failures.clear();
        offer = null;
        plan = null;
        activity = adviceId = null;
    }

    void incident(long incident, String firstFailure) {
        reset();
        this.incident = incident;
        failure(firstFailure);
    }

    void failure(String detail) {
        if (incident == 0 || opened) return;
        String line = detail.strip();
        if (line.isEmpty()) return;
        int bytes = 0, end = 0;
        while (end < line.length()) {
            int codePoint = line.codePointAt(end);
            bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
            if (bytes > 240) break;
            end += Character.charCount(codePoint);
        }
        line = line.substring(0, end).replaceAll("[\\x00-\\x1f\\x7f]", " ").strip();
        if (line.isEmpty()) return;
        if (failures.contains(line)) return;
        if (failures.size() == 5) failures.remove(1); // Keep the reason the incident began.
        failures.add(line);
    }

    boolean canOffer() { return !opened && failures.size() >= 2; }

    AgentExpedition.Offer open(long now, List<AgentExpedition.Option> methods) {
        if (!canOffer() || methods.isEmpty()) return null;
        opened = true;
        until = now + OFFER_TICKS;
        return offer = new AgentExpedition.Offer(new AgentExpedition.Recovery(incident, failures), methods);
    }

    AgentExpedition.Offer live(long now) {
        if (now > until) offer = null;
        return offer;
    }

    void withdraw() { offer = null; }

    void accept(AgentExpedition.Candidate advice, long now) {
        if (advice.offer() != live(now) || advice.recovery() == null || now < advice.basis() || now > advice.expires()) return;
        withdraw();
        plan = advice.recovery();
        adviceId = advice.id();
        until = Math.min(until, advice.expires());
        completed = 0;
        activity = "Situational recovery accepted subgoal: " + plan.subgoal();
        record(method().id(), "accepted", plan.steps().size(), plan.subgoal());
    }

    boolean active() { return plan != null; }
    boolean expired(long now) { return now > until; }
    boolean started() { return started; }
    AgentExpedition.Option method() { return plan.steps().get(completed); }

    void start() {
        started = true;
        if (completed != 0)
            activity = "Situational recovery starting " + method().id() + " after confirming " + completed + " method(s).";
    }

    void result(long now, boolean verified, String evidence) {
        if (!started || !verified || expired(now)) {
            stop(now, expired(now) ? "the advice expired" : evidence);
            return;
        }
        String method = method().id();
        started = false;
        int total = plan.steps().size();
        ++completed;
        record(method, "confirmed", total, evidence);
        if (completed == total) plan = null;
        activity = "Situational recovery confirmed " + method + " (" + completed + "/" + total + "): " + evidence;
        receiptUntil = now + RECEIPT_TICKS;
    }

    void stop(long now, String reason) {
        if (plan == null) return;
        activity = "Situational recovery stopped during " + method().id() + " after confirming " + completed
            + "/" + plan.steps().size() + " methods: " + reason;
        record(method().id(), "stopped", plan.steps().size(), reason);
        plan = null;
        started = false;
        receiptUntil = now + RECEIPT_TICKS;
    }

    private void record(String method, String outcome, int total, String detail) {
        if (receipts == null) receipts = new ArrayList<>(2);
        receipts.add(new Receipt(adviceId, incident, method, outcome, completed, total, detail));
    }

    List<Receipt> takeReceipts() {
        if (receipts == null) return List.of();
        var observed = receipts;
        receipts = null;
        return observed;
    }

    String activity(long now) { return active() || now <= receiptUntil ? activity : null; }

    static boolean provesLanding(boolean driven, boolean different, boolean settled, double distance, boolean openGround) {
        // A checked one-tread rise or return has a precise destination. An open-ground
        // relocation needs more than one short shuffle to count as distinct ground.
        return driven && different && settled && distance >= (openGround ? 1.65 : 0.70);
    }
}
