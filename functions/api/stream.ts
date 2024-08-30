import { RoleScopedChatInput } from "@cloudflare/workers-types";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { documentChunks } from "schema";
import { llmResponse, streamLLMResponse } from "~/lib/aiGateway";

interface EmbeddingResponse {
  shape: number[];
  data: number[][];
}

async function rewriteToQueries(content: string, env: Env): Promise<string[]> {
  const prompt = `Given the following user message, rewrite it into 5 distinct queries that could be used to search for relevant information. Each query should focus on different aspects or potential interpretations of the original message:

User message: "${content}"

Provide 5 queries, one per line and nothing else:`;

  const response = await llmResponse({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    messages: [{ role: "user", content: prompt }],
    apiKeys: {
      openai: env.OPENAI_API_KEY,
      groq: env.GROQ_API_KEY,
      anthropic: env.ANTHROPIC_API_KEY,
    },
    model: "llama-3.1-8b-instant",
    provider: "groq",
    AI: env.AI,
  });

  const regex = /^\d+\.\s*"|"$/gm;
  const queries = response
    .replace(regex, "")
    .split("\n")
    .filter((query) => query.trim() !== "")
    .slice(1, 5);

  return queries;
}

const systemMessage = `You are a helpful assistant that answers questions based on the provided context. When giving a response, always include the source of the information in the format [1], [2], [3] etc.`;

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const ipAddress = ctx.request.headers.get("cf-connecting-ip") || "";

  const rateLimit = await ctx.env.rate_limiter.get(ipAddress);
  if (rateLimit) {
    const lastRequestTime = parseInt(rateLimit);
    const currentTime = Math.floor(Date.now() / 1000);
    if (currentTime - lastRequestTime < 3) {
      return new Response("Too many requests", { status: 429 });
    }
  }

  await ctx.env.rate_limiter.put(ipAddress, Math.floor(Date.now() / 1000).toString(), {
    expirationTtl: 60,
  });

  ctx.waitUntil(
    (async () => {
      const json = await ctx.request.json();
      const { provider, model, sessionId } = json;
      const messages: RoleScopedChatInput[] = json.messages as RoleScopedChatInput[];
      messages.unshift({ role: "system", content: systemMessage });
      const lastMessage = messages[messages.length - 1];
      const query = lastMessage.content;

      const db = drizzle(ctx.env.DB);
      const textEncoder = new TextEncoder();

      await writer.write(
        textEncoder.encode(`data: {"message": "Rewriting message to queries..."}\n\n`)
      );
      const queries = await rewriteToQueries(query, ctx.env);

      const queryVectors: EmbeddingResponse[] = await Promise.all(
        queries.map((q) => ctx.env.AI.run("@cf/baai/bge-large-en-v1.5", { text: [q] }))
      );

      const queryingVectorIndexMsg = {
        message: "Querying vector index...",
        queries,
      };

      await writer.write(textEncoder.encode(`data: ${JSON.stringify(queryingVectorIndexMsg)}\n\n`));

      const allResults = await Promise.all(
        queryVectors.map((qv) =>
          ctx.env.VECTORIZE_INDEX.query(qv.data[0], {
            topK: 5,
            returnValues: true,
            returnMetadata: "all",
            namespace: "default",
            filter: {
              sessionId,
            },
          })
        )
      );

      const allResultsFlattened = Array.from(
        new Set(allResults.flatMap((r) => r.matches.map((m) => m.id)))
      ).map((id) => allResults.flatMap((r) => r.matches).find((m) => m.id === id));

      const relevantDocs = await db
        .select({ text: documentChunks.text })
        .from(documentChunks)
        .where(
          inArray(
            documentChunks.id,
            allResultsFlattened.map((r) => r?.id || "unknown")
          )
        );

      const relevantTexts = relevantDocs
        .map((doc, index) => `[${index + 1}]: ${doc.text}`)
        .join("\n\n");

      const relevantDocsMsg = {
        message: "Found relevant documents...",
        relevantContext: relevantDocs,
        queries,
      };
      await writer.write(textEncoder.encode(`data: ${JSON.stringify(relevantDocsMsg)}\n\n`));

      messages.push({
        role: "assistant",
        content: `The following queries were made:\n${queries.join(
          "\n"
        )}\n\nRelevant context from attached documents:\n${relevantTexts}`,
      });

      const apiKeys = {
        anthropic: ctx.env.ANTHROPIC_API_KEY,
        openai: ctx.env.OPENAI_API_KEY,
        groq: ctx.env.GROQ_API_KEY,
      };

      try {
        const stream = await streamLLMResponse({
          accountId: ctx.env.CLOUDFLARE_ACCOUNT_ID,
          messages,
          apiKeys,
          model,
          provider,
          AI: ctx.env.AI,
        });

        writer.releaseLock();

        (stream as Response).body
          ? await (stream as Response).body?.pipeTo(writable)
          : await (stream as ReadableStream).pipeTo(writable);
      } catch (error) {
        await writer.write(textEncoder.encode("Error: " + error));
        await writer.close();
      }
    })()
  );

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Transfer-Encoding": "chunked",
      "content-encoding": "identity",
    },
  });
};
