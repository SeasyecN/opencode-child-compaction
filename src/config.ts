import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type SummarizationConfig = {
  readonly providerID: string;
  readonly modelID: string;
};

class SummarizationConfigError extends Error {
  readonly name = "SummarizationConfigError";

  constructor(readonly configPath: string, cause?: Error) {
    super(
      `Cannot initialize child compaction: create or fix ${configPath}. ` +
      'It must be readable JSON containing only "providerID" and "modelID", both nonblank strings. ' +
      "Restart OpenCode after fixing the file.",
      { cause },
    );
  }
}

export async function loadSummarizationConfig(configUrl: URL): Promise<SummarizationConfig> {
  const configPath = fileURLToPath(configUrl);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(configUrl, "utf8"));
  } catch (error) {
    if (error instanceof Error) throw new SummarizationConfigError(configPath, error);
    throw error;
  }

  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !("providerID" in value) || typeof value.providerID !== "string" || value.providerID.trim() === "" ||
    !("modelID" in value) || typeof value.modelID !== "string" || value.modelID.trim() === "" ||
    Object.keys(value).length !== 2
  ) {
    throw new SummarizationConfigError(configPath);
  }

  return { providerID: value.providerID, modelID: value.modelID };
}
