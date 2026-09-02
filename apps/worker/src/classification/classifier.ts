import { EVENT_CATEGORIES, type EventCategory } from "@easycal/contracts/event";

export interface EventCategoryInput {
  title: string | null;
  description: string | null;
  locationName: string | null;
  sourceLabel: string | null;
  evidenceText: string;
}

export interface EventCategoryClassifier {
  classify(input: EventCategoryInput): Promise<EventCategory[]>;
}

const CATEGORY_SET = new Set<string>(EVENT_CATEGORIES);

export function validateCategories(value: unknown): EventCategory[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(
    (item): item is EventCategory => typeof item === "string" && CATEGORY_SET.has(item),
  ))];
}

const SIGNALS: Array<[EventCategory, RegExp]> = [
  ["career", /\b(?:career|job|jobs|hiring|recruit|employment|career fair|intern|internship|internships)\b/i],
  ["internships", /\b(?:intern|internship|internships|traineeship)\b/i],
  ["technology", /\b(?:ai|artificial intelligence|tech|technology|software|coding|developer|hackathon|product)\b/i],
  ["entrepreneurship", /\b(?:noc|startup|start-up|founder|entrepreneur|venture|pitch)\b/i],
  ["education", /\b(?:workshop|course|class|lecture|seminar|learn|training|sharing)\b/i],
  ["networking", /\b(?:networking|network|mixer|meet professionals|connect with)\b/i],
  ["community", /\b(?:community|meetup|alumni|sharing|coffee chat|gathering)\b/i],
  ["volunteering", /\b(?:volunteer|volunteering|service project|fundraiser)\b/i],
  ["sports_wellness", /\b(?:sport|fitness|wellness|run|running|yoga|football|basketball)\b/i],
  ["arts_culture", /\b(?:art|arts|culture|music|theatre|theater|film|design|creative)\b/i],
  ["social", /\b(?:social|party|games night|game night|dinner|breakfast)\b/i],
];

export class DeterministicEventCategoryClassifier implements EventCategoryClassifier {
  async classify(input: EventCategoryInput): Promise<EventCategory[]> {
    const text = [input.title, input.description, input.locationName, input.sourceLabel, input.evidenceText]
      .filter(Boolean)
      .join("\n");
    const matches = SIGNALS.filter(([, signal]) => signal.test(text)).map(([category]) => category);
    return matches.length > 0 ? [...new Set(matches)] : ["other"];
  }
}

interface ResponsesPayload {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
}

type ModelRequest = (body: Record<string, unknown>) => Promise<ResponsesPayload>;

export interface OpenAIClassifierOptions {
  apiKey: string;
  model: string;
  request?: ModelRequest;
  fallback?: EventCategoryClassifier;
}

export class OpenAIEventCategoryClassifier implements EventCategoryClassifier {
  private readonly request: ModelRequest;
  private readonly fallback: EventCategoryClassifier;

  constructor(private readonly options: OpenAIClassifierOptions) {
    this.fallback = options.fallback ?? new DeterministicEventCategoryClassifier();
    this.request = options.request ?? (async (body) => {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`category_model_${response.status}`);
      return response.json() as Promise<ResponsesPayload>;
    });
  }

  async classify(input: EventCategoryInput): Promise<EventCategory[]> {
    try {
      const response = await this.request({
        model: this.options.model,
        store: false,
        instructions: "Classify the event into every applicable allowed category. Return categories only.",
        input: JSON.stringify(input),
        text: {
          format: {
            type: "json_schema",
            name: "event_categories",
            strict: true,
            schema: {
              type: "object",
              properties: {
                categories: {
                  type: "array",
                  items: { type: "string", enum: EVENT_CATEGORIES },
                  minItems: 1,
                  uniqueItems: true,
                },
              },
              required: ["categories"],
              additionalProperties: false,
            },
          },
        },
      });
      const text = response.output_text
        ?? response.output?.flatMap((item) => item.content ?? []).find((item) => item.text)?.text;
      const categories = validateCategories(text ? JSON.parse(text).categories : null);
      if (categories.length > 0) return categories;
    } catch {
      // Classification must never make the Telegram sync fail.
    }
    return this.fallback.classify(input);
  }
}

export function createEventCategoryClassifier(config: {
  apiKey?: string;
  model?: string;
}): EventCategoryClassifier {
  if (config.apiKey && config.model) {
    return new OpenAIEventCategoryClassifier({ apiKey: config.apiKey, model: config.model });
  }
  return new DeterministicEventCategoryClassifier();
}
