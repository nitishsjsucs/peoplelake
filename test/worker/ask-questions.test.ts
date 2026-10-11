// The 60 ask eval questions (evals/ask/questions.jsonl): every expected answer is a valid MetricQuery,
// 12 questions per metric, unique ids and questions. Scoring happens in `peoplelake eval ask`.
import { describe, expect, it } from "vitest";
import questionsText from "../../evals/ask/questions.jsonl?raw";
import { MetricQuery } from "../../src/worker/ai/providers.ts";
import { METRIC_IDS } from "../../src/shared/metrics.ts";

interface Question {
  id: string;
  question: string;
  expected: unknown;
}

const questions: Question[] = questionsText
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Question);

describe("ask eval questions", () => {
  it("has 60 questions with unique ids and texts", () => {
    expect(questions).toHaveLength(60);
    expect(new Set(questions.map((q) => q.id)).size).toBe(60);
    expect(new Set(questions.map((q) => q.question.toLowerCase())).size).toBe(60);
  });

  it("expects a valid MetricQuery for every question", () => {
    for (const q of questions) {
      const parsed = MetricQuery.safeParse(q.expected);
      expect(parsed.success, `${q.id}: ${JSON.stringify(q.expected)}`).toBe(true);
    }
  });

  it("covers each of the five metrics with 12 questions", () => {
    for (const metric of METRIC_IDS) {
      expect(questions.filter((q) => (q.expected as { metric: string }).metric === metric)).toHaveLength(12);
    }
  });
});
