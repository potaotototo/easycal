import { describe, expect, it } from "vitest";
import {
  DeterministicEventCategoryClassifier,
  OpenAIEventCategoryClassifier,
  validateCategories,
} from "./classifier.js";

const baseInput = {
  description: null,
  locationName: null,
  sourceLabel: null,
  evidenceText: "",
};

describe("event category classification", () => {
  it("classifies known event signals and falls back to other", async () => {
    const classifier = new DeterministicEventCategoryClassifier();

    await expect(classifier.classify({ ...baseInput, title: "NOC startup alumni sharing" }))
      .resolves.toEqual(expect.arrayContaining(["entrepreneurship", "community"]));
    await expect(classifier.classify({ ...baseInput, title: "Women in Tech Career Fair" }))
      .resolves.toEqual(expect.arrayContaining(["career", "technology"]));
    await expect(classifier.classify({ ...baseInput, title: "Miscellaneous announcement" }))
      .resolves.toEqual(["other"]);
  });

  it("keeps only unique supported categories", () => {
    expect(validateCategories(["career", "career", "made_up", 3])).toEqual(["career"]);
    expect(validateCategories([])).toEqual([]);
  });

  it("uses validated structured model output", async () => {
    const classifier = new OpenAIEventCategoryClassifier({
      apiKey: "test-key",
      model: "test-model",
      request: async () => ({ output_text: '{"categories":["technology","made_up"]}' }),
    });

    await expect(classifier.classify({ ...baseInput, title: "AI workshop" }))
      .resolves.toEqual(["technology"]);
  });

  it("falls back deterministically when the model request fails", async () => {
    const classifier = new OpenAIEventCategoryClassifier({
      apiKey: "test-key",
      model: "test-model",
      request: async () => { throw new Error("offline"); },
    });

    await expect(classifier.classify({ ...baseInput, title: "Internship fair" }))
      .resolves.toEqual(expect.arrayContaining(["career", "internships"]));
  });
});
