import { resolve, join } from "node:path";
import { access } from "node:fs/promises";

export const DEFAULT_MODEL = "Xenova/bge-small-zh-v1.5";
export const DEFAULT_REVISION = "75c43b069aac4d136ba6bc1122f995fedcfd2781";
export const DIMENSIONS = 512;
const pipelines = new Map();

export function validVector(value) {
  return (
    Array.isArray(value) &&
    value.length === DIMENSIONS &&
    value.every(Number.isFinite) &&
    value.some((n) => n !== 0)
  );
}

export function localEmbedding({
  model = DEFAULT_MODEL,
  modelCacheDir = "var/models",
  revision = model === DEFAULT_MODEL ? DEFAULT_REVISION : "main",
} = {}) {
  const cacheDir = resolve(modelCacheDir);
  const key = `${model}@${revision}|q8|cls|${DIMENSIONS}|query-instruction-v1`;
  return {
    key,
    async embed(text, { query = false } = {}) {
      const identity = `${cacheDir}:${model}@${revision}`;
      if (!pipelines.has(identity)) {
        const load = import("@huggingface/transformers").then(
          async ({ pipeline }) => {
            const cached = join(cacheDir, model);
            let local = false;
            try {
              await access(join(cached, "config.json"));
              await access(join(cached, "onnx/model_quantized.onnx"));
              local = true;
            } catch {}
            return pipeline("feature-extraction", local ? cached : model, {
              dtype: "q8",
              device: "cpu",
              cache_dir: cacheDir,
              revision,
              ...(local ? { local_files_only: true } : {}),
            });
          },
        );
        pipelines.set(identity, load);
        load.catch(() => pipelines.delete(identity));
      }
      const extractor = await pipelines.get(identity);
      const input = query
        ? "为这个句子生成表示以用于检索相关文章：" + text
        : text;
      const tensor = await extractor(input, {
        pooling: "cls",
        normalize: true,
        truncation: true,
      });
      const vector = Array.from(tensor.data);
      if (!validVector(vector)) throw new Error("knowledge_embedding_invalid");
      return vector;
    },
  };
}
