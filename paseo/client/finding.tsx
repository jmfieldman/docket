// One finding in full: summary, verdict, options, the decide controls,
// discussion, the reviewer's words, and the resolution. It mirrors the
// expanded finding in the Claude Code pane.
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { Pressable, View } from "react-native";
import { OUTCOME } from "../shared/model";
import { docketApi } from "../shared/rpc";
import { Button, capped, Card, Field, Row, Section, T, type Kit } from "./ui";
import { unwrap, type Summary } from "./types";

interface Option {
  id: string;
  kind: string;
  title: string;
  description?: string;
  effort?: string;
  pros: string[];
  cons: string[];
  blastRadius?: { level?: string; estimatedFiles?: number | null };
}

interface FindingDoc {
  id: string;
  rev: number;
  state: string;
  summary?: string;
  severityRationale?: string;
  location?: { path: string; startLine?: number; symbol?: string };
  research?: { verdict: string; confidence: string; recommendedOptionId: string; options: Option[] };
  triage?: { complexityReason: string; confidenceReason: string };
  iterations: { decision: { optionId: string }; queue?: { position: number } }[];
  discussion?: { entries: { question: string; answer: string; at: string }[] };
  sources: { sourceId: string; excerpt: string }[];
  resolution?: { summary?: string; reason?: string; deferral?: { path: string } };
  reply?: { status: string; draft?: string };
  stale?: { reason: string } | null;
}

export interface FindingActions {
  act(name: string, args: Record<string, unknown>, done: string | null): Promise<void>;
  plan(kind: "research" | "apply" | "discuss" | "quickFix", args?: Record<string, unknown>): Promise<void>;
  say(message: string): void;
}

export function FindingDetail({ kit, cwd, summary, active, actions }: { kit: Kit; cwd: string; summary: Summary; active: boolean; actions: FindingActions }) {
  const api = useRpc(docketApi);
  const query = useQuery({
    queryKey: ["docket", "finding", cwd, summary.id, summary.rev],
    queryFn: async () => unwrap<{ finding: FindingDoc; sources: Record<string, { author?: string; title?: string } | null> }>(await api({ cwd, op: "finding", name: summary.id })),
  });
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [reply, setReply] = useState("");
  const c = kit.theme.colors;

  if (query.isPending) return <T kit={kit} muted>Loading…</T>;
  if (query.isError) return <T kit={kit} color={c.statusDanger}>{query.error.message}</T>;

  const f = query.data.finding;
  const sources = query.data.sources ?? {};
  const last = f.iterations.at(-1) ?? null;
  const queuedOption = f.state === "queued" && last ? last.decision.optionId : null;
  // Queued findings stay editable: the decide button removes them from the queue, or switches option.
  const editable = active && summary.open && f.state !== "fixing";
  const trimmed = note.trim();

  const parts: ReactElement[] = [];

  parts.push(
    <Section key="summary" kit={kit} title="Summary">
      <T kit={kit} selectable>{capped(f.summary, 4000)}</T>
      {f.location ? <Field kit={kit} label="Where" value={f.location.path + (f.location.startLine ? ":" + f.location.startLine : "") + (f.location.symbol ? " · " + f.location.symbol : "")} /> : null}
      {f.severityRationale ? <Field kit={kit} label="Why" value={f.severityRationale} /> : null}
    </Section>,
  );

  if (f.research) {
    const research = f.research;
    const selected = choice ?? queuedOption ?? research.recommendedOptionId;
    const chosen = research.options.find((o) => o.id === selected);
    const isQueuedChoice = selected === queuedOption;

    parts.push(
      <Section key="verdict" kit={kit} title="Verdict">
        <T kit={kit}>
          <T kit={kit} bold>{research.verdict.replace("_", " ")}</T>
          {" · " + research.confidence + " confidence"}
        </T>
        {f.triage ? <T kit={kit} muted size={13}>{f.triage.complexityReason + " " + f.triage.confidenceReason}</T> : null}
      </Section>,
    );

    parts.push(
      <Section key="options" kit={kit} title="Options">
        {research.options.map((o) => {
          const isSel = o.id === selected;
          const isRec = o.id === research.recommendedOptionId;
          const br = o.blastRadius ?? {};
          const tag = [o.kind, o.effort, br.level, br.estimatedFiles != null ? "~" + br.estimatedFiles + " files" : ""].filter(Boolean).join(" · ");
          return (
            <View key={o.id} style={{ gap: 4 }}>
              <Pressable accessibilityRole="radio" accessibilityState={{ selected: isSel }} accessibilityLabel={"Option " + o.id + ": " + o.title} onPress={() => setChoice(o.id)}>
                <T kit={kit}>
                  <T kit={kit} bold={isSel} muted={!isSel && !isRec}>{(isSel ? "◉ " : "○ ") + o.id + ". " + o.title}</T>
                  {isRec ? <T kit={kit} bold color={c.statusSuccess}>{"  ★ recommended"}</T> : null}
                  {o.id === queuedOption ? <T kit={kit} color={c.statusWarning}>{"  ● queued"}</T> : null}
                  <T kit={kit} muted size={12}>{"  [" + tag + "]"}</T>
                </T>
              </Pressable>
              {isSel ? (
                <View style={{ paddingLeft: 18, gap: 3 }}>
                  {o.description ? <T kit={kit} size={13} selectable>{capped(o.description, 4000)}</T> : null}
                  {o.pros.map((x, i) => (
                    <T key={"p" + i} kit={kit} size={13}>
                      <T kit={kit} color={c.statusSuccess} size={13}>{"+ "}</T>
                      {x}
                    </T>
                  ))}
                  {o.cons.map((x, i) => (
                    <T key={"c" + i} kit={kit} size={13}>
                      <T kit={kit} color={c.statusDanger} size={13}>{"− "}</T>
                      {x}
                    </T>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
      </Section>,
    );

    if (editable) {
      const decideLabel = isQueuedChoice
        ? "Remove from queue"
        : chosen?.kind === "fix"
          ? queuedOption ? "Queue " + selected + " instead" : "Queue " + selected
          : chosen?.kind === "defer" ? "Defer" : "Leave as is (" + selected + ")";
      parts.push(
        <Section key="decide" kit={kit} title="Decide">
          {f.state === "queued" ? (
            <T kit={kit} color={c.statusWarning}>{"Queued" + (last?.queue ? " at position " + last.queue.position : "") + " with option " + queuedOption + "."}</T>
          ) : null}
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Note: extra direction, or why you leave or defer it"
            placeholderTextColor={c.foregroundMuted}
            multiline
            style={{ color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 8, minHeight: 40, backgroundColor: c.surface0 }}
          />
          <Row>
            <Button
              kit={kit}
              tone="primary"
              label={decideLabel}
              onPress={async () => {
                if (isQueuedChoice) return actions.act("unqueue", { id: f.id }, "Removed " + f.id + " from the queue.");
                if (chosen?.kind !== "fix" && !trimmed) return actions.say("Add a note saying why, then decide again.");
                setNote("");
                await actions.act("decide", { id: f.id, optionId: selected, instruction: trimmed || undefined }, (chosen?.kind === "fix" ? "Queued " : chosen?.kind === "defer" ? "Deferred " : "Acknowledged ") + f.id + ".");
              }}
            />
            {chosen?.kind === "fix" ? (
              <Button
                kit={kit}
                label={isQueuedChoice ? "Apply now" : "Quick fix"}
                onPress={async () => {
                  if (isQueuedChoice) return actions.plan("apply");
                  if (trimmed) {
                    setNote("");
                    await actions.act("decide", { id: f.id, optionId: selected, instruction: trimmed, origin: "quick" }, "Queued " + f.id + ".");
                    return actions.plan("apply");
                  }
                  return actions.plan("quickFix", { id: f.id, optionId: selected });
                }}
              />
            ) : null}
            <Button
              kit={kit}
              tone="quiet"
              label="Leave as is…"
              onPress={async () => {
                if (!trimmed) return actions.say("Add a note saying why no change is needed.");
                setNote("");
                await actions.act("decide", { id: f.id, optionId: "custom", kind: "acknowledge", instruction: trimmed }, "Acknowledged " + f.id + ".");
              }}
            />
            <Button kit={kit} label={f.state === "discussing" ? "Continue discussion" : "Discuss"} onPress={() => actions.plan("discuss", { id: f.id })} />
            {f.stale ? <Button kit={kit} tone="quiet" label="Clear stale" onPress={() => actions.act("unstale", { id: f.id }, "Stale flag cleared.")} /> : null}
          </Row>
        </Section>,
      );
    } else if (f.state === "fixing") {
      parts.push(
        <Section key="status" kit={kit} title="Status">
          <T kit={kit} color={c.statusWarning}>The applier is working on this finding.</T>
        </Section>,
      );
    }
  } else if (active && summary.open) {
    parts.push(
      <Section key="next" kit={kit} title="Next">
        <Row>
          <Button kit={kit} tone="primary" label="Research this finding" onPress={() => actions.plan("research", { ids: [f.id] })} />
        </Row>
      </Section>,
    );
  }

  if (f.discussion && f.discussion.entries.length) {
    parts.push(
      <Section key="discussion" kit={kit} title="Discussion">
        {f.discussion.entries.slice(-3).map((entry) => (
          <View key={entry.at} style={{ gap: 2 }}>
            <T kit={kit}>
              <T kit={kit} bold>{"Q "}</T>
              {entry.question}
            </T>
            <T kit={kit} size={13} style={{ paddingLeft: 14 }} selectable>{capped(entry.answer, 3000)}</T>
          </View>
        ))}
      </Section>,
    );
  }

  parts.push(
    <Section key="sources" kit={kit} title="Review comments">
      {f.sources.slice(0, 3).map((ref) => {
        const src = sources[ref.sourceId] ?? {};
        return (
          <View key={ref.sourceId} style={{ gap: 2 }}>
            <T kit={kit} italic size={13} selectable>{"“" + capped(ref.excerpt, 3000) + "”"}</T>
            <T kit={kit} muted size={12}>{"— " + (src.author ?? src.title ?? ref.sourceId)}</T>
          </View>
        );
      })}
    </Section>,
  );

  if (!summary.open) {
    parts.push(
      <Section key="resolution" kit={kit} title="Resolution">
        <Field kit={kit} label="Outcome" value={(OUTCOME[f.state] ?? f.state) + (f.resolution?.summary ? " — " + f.resolution.summary : "")} />
        {f.resolution?.reason ? <Field kit={kit} label="Reason" value={f.resolution.reason} /> : null}
        {f.resolution?.deferral ? <Field kit={kit} label="File" value={f.resolution.deferral.path} /> : null}
      </Section>,
    );
    if (f.reply?.status === "drafted" && active) {
      parts.push(
        <Section key="reply" kit={kit} title="Reply draft">
          <T kit={kit} size={13} selectable>{capped(f.reply.draft, 4000)}</T>
          <TextInput
            value={reply}
            onChangeText={setReply}
            placeholder="Type a new reply to replace the draft"
            placeholderTextColor={c.foregroundMuted}
            multiline
            style={{ color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 8, minHeight: 40, backgroundColor: c.surface0 }}
          />
          <Row>
            {reply.trim() ? (
              <Button
                kit={kit}
                label="Save reply"
                onPress={async () => {
                  const text = reply.trim();
                  setReply("");
                  await actions.act("replyEdit", { id: f.id, text }, "Reply saved.");
                }}
              />
            ) : null}
            <Button kit={kit} tone="primary" label="Approve reply" onPress={() => actions.act("replyApprove", { id: f.id }, "Reply approved. Press Replies to post approved replies.")} />
            <Button kit={kit} tone="quiet" label="Skip reply" onPress={() => actions.act("replySkip", { id: f.id }, "Reply skipped.")} />
          </Row>
        </Section>,
      );
    }
    if (active && f.state !== "resolved_externally") {
      parts.push(
        <Row key="reopen" style={{ marginTop: 12 }}>
          <Button kit={kit} tone="quiet" label="Reopen" onPress={() => actions.act("reopen", { id: f.id, reason: "Reopened from the Docket panel in Paseo." }, "Reopened " + f.id + ".")} />
        </Row>,
      );
    }
  }

  return <Card kit={kit}>{parts}</Card>;
}
