import { App } from "obsidian";
import { LeafExtract } from "./leaf-context";
import { Availability, MasteryEntry, scheduleReviews, upsertMastery } from "./scheduler";

/**
 * Teach Me loop. Turns a source (a read tab, a dropped file, a CFA doc,
 * an old lecture) into diagnose → teach → check → card → schedule → track.
 *
 * The teaching itself runs through the normal chat engine via a framed prompt; this
 * module composes that prompt and seeds the retention loop (mastery entry + spaced
 * reviews) so the topic re-surfaces on the availability schedule.
 */

export const TEACH_SYSTEM =
  "You are a patient tutor. Teach the provided material so the user truly learns it: " +
  "(1) briefly gauge what they likely already know, (2) explain from fundamentals with an " +
  "analogy and one worked example, (3) check understanding with 2-3 active-recall questions " +
  "and pause for answers, (4) finish by generating 3-6 spaced-repetition flashcards as " +
  "'Question :: Answer' lines or with ==cloze== deletions. Be concise and concrete.";

export type TeachMode = "explain" | "deep" | "drill";

export function composeTeachRequest(ex: LeafExtract, mode: TeachMode): string {
  const intro =
    mode === "drill"
      ? "Quiz me on this material with active recall, then grade my answers and tell me what to review:"
      : mode === "deep"
        ? "Teach me this in depth — I've forgotten it and want to relearn it properly:"
        : "Teach me this clearly:";
  return `${intro}\n\n${TEACH_SYSTEM}\n\n---\n\n**${ex.title}** (\`${ex.source}\`)\n\n${ex.content}`;
}

/** Seed/refresh the mastery entry + schedule spaced reviews for a freshly-taught topic. */
export async function recordTeachSession(
  app: App,
  masteryPath: string,
  availability: Availability,
  ex: LeafExtract,
  now: Date,
): Promise<{ reviews: { interval: number; whenISO: string }[] }> {
  const reviews = scheduleReviews(now, availability);
  const p = (n: number) => String(n).padStart(2, "0");
  const localDay = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`; // local, not UTC
  const entry: MasteryEntry = {
    topic: ex.title,
    source: ex.source,
    confidence: 30,
    lastTaught: localDay,
    nextReview: reviews[0]?.whenISO ?? "",
    lapses: 0,
  };
  await upsertMastery(app, masteryPath, entry);
  return { reviews };
}
