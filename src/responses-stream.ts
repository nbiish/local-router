import { Writable } from 'stream';

export type ResponsesStreamEvent = {
  type: string;
  [key: string]: unknown;
};

export function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

export function chatCompletionToResponsesResponse(chatData: any, presentedModel: string): any {
  const choice = chatData?.choices?.[0] || {};
  const message = choice.message || {};
  const content = message.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((p: any) => p?.type === 'text' || typeof p?.text === 'string')
            .map((p: any) => p.text)
            .join('\n')
        : '';

  const output: any[] = [];
  // A Responses client (Codex) reads reasoning from its own output item, not from the message text
  // and not from usage alone. The usage block already reported reasoning_tokens while output carried
  // no reasoning item, so the client was told tokens were spent on reasoning it was never shown.
  const reasoningText = String(
    message.reasoning ?? message.reasoning_content ?? message.thinking ?? ''
  );
  if (reasoningText) {
    output.push({
      type: 'reasoning',
      id: `rs_${chatData?.id || cryptoRandomId()}`,
      summary: [{ type: 'summary_text', text: reasoningText }]
    });
  }
  if (text) {
    output.push({
      type: 'message',
      id: `msg_${chatData?.id || cryptoRandomId()}`,
      role: message.role || 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }]
    });
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const call of message.tool_calls) {
      output.push({
        type: 'function_call',
        id: call.id || `call_${cryptoRandomId()}`,
        call_id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments || ''
      });
    }
  }

  const usage = chatData?.usage || {};
  return {
    id: chatData?.id || `resp_${cryptoRandomId()}`,
    object: 'response',
    created_at: chatData?.created || Math.floor(Date.now() / 1000),
    model: chatData?.model || presentedModel,
    status: choice.finish_reason === 'length' ? 'incomplete' : 'completed',
    incomplete_details: choice.finish_reason === 'length' ? { reason: 'max_output_tokens' } : null,
    output,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      input_tokens_details: {
        cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0
      },
      output_tokens_details: {
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || usage.reasoning_tokens || 0
      }
    }
  };
}

export function buildResponseCreatedEvent(responseId: string, modelId: string): ResponsesStreamEvent {
  return {
    type: 'response.created',
    response: {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: modelId,
      status: 'in_progress',
      output: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 }
      }
    }
  };
}

export function formatResponsesSseEvent(event: ResponsesStreamEvent): string {
  const eventName = typeof event.type === 'string' ? event.type : 'error';
  return `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
}

export type ResponsesFakeResponse = Writable & {
  statusCode: number;
  setHeader: () => ResponsesFakeResponse;
  status: (code: number) => ResponsesFakeResponse;
  json: (data: any) => void;
};

export function createResponsesFakeResponse(options: {
  emit: (event: ResponsesStreamEvent) => void;
  modelId: string;
  responseId: string;
  onFinished?: () => void;
}): ResponsesFakeResponse {
  const { emit, modelId, responseId, onFinished } = options;
  const outputItemMsgId = `msg_${cryptoRandomId()}`;
  const reasoningItemId = `rs_${cryptoRandomId()}`;
  let reasoningItemAdded = false;
  // Output slots are allocated in announcement order and never reused, so a
  // reasoning item, the answer, and each tool call each own a stable index.
  // Both branches need this: the reasoning item shifts the message off 0, and a
  // tool call must not collide with the text item.
  let nextOutputIndex = 0;
  const allocateOutputIndex = () => nextOutputIndex++;
  let itemAdded = false;
  let messageOutputIndex = -1;
  let reasoningOutputIndex = -1;
  let sseBuffer = '';
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  // Cache and reasoning counters. Hardcoding these to 0 (what this did) made a
  // streamed turn claim it cached nothing and reasoned about nothing, while the
  // same request answered with correct numbers on the non-streaming path — so a
  // warm cache was indistinguishable from a cold one on the wire Codex uses.
  let cachedTokens = 0;
  let reasoningTokens = 0;
  let reasoningText = '';
  let finishReason = '';
  // Tool calls stream in as fragments keyed by index. A Responses client reads
  // each one as its own `function_call` output item — an event name of our own
  // invention (`response.output_tool_call.arguments.delta`) is not in the
  // Responses vocabulary, so Codex silently dropped every tool call and hung
  // waiting for an item that never arrived.
  const toolCalls = new Map<number, { id: string; callId: string; name: string; args: string; added: boolean; outputIndex: number }>();

  const finish = () => {
    onFinished?.();
  };

  const ensureItem = (role?: string) => {
    if (itemAdded) return;
    itemAdded = true;
    messageOutputIndex = allocateOutputIndex();
    emit({
      type: 'response.output_item.added',
      response_id: responseId,
      output_index: messageOutputIndex,
      item: {
        id: outputItemMsgId,
        type: 'message',
        status: 'in_progress',
        role: role || 'assistant',
        content: []
      }
    });
  };

  // One decoder for both the streaming body and a trailing partial line, so a
  // final chunk can never be counted twice.
  const absorb = (data: any) => {
    if (typeof data?.usage?.prompt_tokens === 'number') inputTokens = data.usage.prompt_tokens;
    if (typeof data?.usage?.completion_tokens === 'number') outputTokens = data.usage.completion_tokens;
    const cached = data?.usage?.prompt_tokens_details?.cached_tokens
      ?? data?.usage?.input_tokens_details?.cached_tokens
      ?? data?.usage?.cached_tokens;
    if (typeof cached === 'number') cachedTokens = cached;
    const reasoned = data?.usage?.completion_tokens_details?.reasoning_tokens
      ?? data?.usage?.output_tokens_details?.reasoning_tokens
      ?? data?.usage?.reasoning_tokens;
    if (typeof reasoned === 'number') reasoningTokens = reasoned;

    const choice = data?.choices?.[0] || {};
    const delta = choice.delta || {};
    if (choice.finish_reason) finishReason = String(choice.finish_reason);

    // The Responses wire carries reasoning as its own output item. Without one the
    // usage block claims reasoning tokens the client was never shown.
    const thinking = delta.reasoning ?? delta.reasoning_content ?? delta.thinking;
    if (typeof thinking === 'string' && thinking.length > 0) {
      reasoningText += thinking;
      if (!reasoningItemAdded) {
        reasoningItemAdded = true;
        reasoningOutputIndex = allocateOutputIndex();
        emit({
          type: 'response.output_item.added',
          response_id: responseId,
          output_index: reasoningOutputIndex,
          item: {
            id: reasoningItemId,
            type: 'reasoning',
            status: 'in_progress',
            summary: []
          }
        });
      }
      emit({
        type: 'response.reasoning_summary_text.delta',
        response_id: responseId,
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: 0,
        delta: thinking
      });
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      // Announced here rather than on a role-only delta: an item that is
      // `added` and never `done` leaves the client waiting for its completion,
      // which is exactly the hang this shim used to cause.
      ensureItem(delta.role);
      text += delta.content;
      emit({
        type: 'response.output_text.delta',
        response_id: responseId,
        item_id: outputItemMsgId,
        content_index: 0,
        delta: delta.content
      });
    }

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      for (let position = 0; position < delta.tool_calls.length; position += 1) {
        const tc = delta.tool_calls[position] || {};
        const index = typeof tc.index === 'number' ? tc.index : position;
        let entry = toolCalls.get(index);
        if (!entry) {
          entry = {
            id: `fc_${cryptoRandomId()}`,
            callId: tc.id || `call_${cryptoRandomId()}`,
            name: tc.function?.name || '',
            args: '',
            added: false,
            outputIndex: -1
          };
          toolCalls.set(index, entry);
        }
        if (tc.function?.name) entry.name = tc.function.name;
        // OpenAI streams the call id on the first fragment only; keep the first
        // one we see so the emitted function_call item and its deltas agree.
        if (tc.id && !entry.added) entry.callId = tc.id;

        if (!entry.added) {
          entry.added = true;
          entry.outputIndex = allocateOutputIndex();
          emit({
            type: 'response.output_item.added',
            response_id: responseId,
            output_index: entry.outputIndex,
            item: {
              id: entry.id,
              type: 'function_call',
              status: 'in_progress',
              call_id: entry.callId,
              name: entry.name,
              arguments: ''
            }
          });
        }

        const fragment = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
        if (fragment) {
          entry.args += fragment;
          emit({
            type: 'response.function_call_arguments.delta',
            response_id: responseId,
            item_id: entry.id,
            output_index: entry.outputIndex,
            delta: fragment
          });
        }
      }
    }
  };

  const finalize = () => {
    const status = finishReason === 'length' ? 'incomplete' : 'completed';
    const content = [{ type: 'output_text', text, annotations: [] }];
    const output: any[] = [];

    // Reasoning first: the Responses client reads it from its own output item, and
    // Anthropic-style ordering (reasoning before the answer) is what makes the
    // indices below stable.
    if (reasoningText) {
      const reasoningItem = {
        id: reasoningItemId,
        type: 'reasoning',
        status,
        summary: [{ type: 'summary_text', text: reasoningText }]
      };
      emit({
        type: 'response.reasoning_summary_text.done',
        response_id: responseId,
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: 0,
        text: reasoningText
      });
      emit({
        type: 'response.output_item.done',
        response_id: responseId,
        output_index: reasoningOutputIndex,
        item: reasoningItem
      });
      output.push(reasoningItem);
    }

    // Codex reads the terminal item/response content, not just the deltas: an
    // empty `output_text` here shows the turn as successful with no answer.
    // With tool calls present the text item is only emitted when it carries
    // content, so the terminal output stays in the order it streamed.
    if (text) {
      if (!itemAdded) ensureItem('assistant');
      emit({
        type: 'response.output_text.done',
        response_id: responseId,
        item_id: outputItemMsgId,
        output_index: messageOutputIndex,
        content_index: 0,
        text
      });
      const messageItem = {
        id: outputItemMsgId,
        type: 'message',
        status,
        role: 'assistant',
        content
      };
      emit({
        type: 'response.output_item.done',
        response_id: responseId,
        output_index: messageOutputIndex,
        item: messageItem
      });
      output.push(messageItem);
    }

    const orderedTools = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, entry] of orderedTools) {
      emit({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        item_id: entry.id,
        output_index: entry.outputIndex,
        arguments: entry.args
      });
      const callItem = {
        id: entry.id,
        type: 'function_call',
        status,
        call_id: entry.callId,
        name: entry.name,
        arguments: entry.args
      };
      emit({
        type: 'response.output_item.done',
        response_id: responseId,
        output_index: entry.outputIndex,
        item: callItem
      });
      output.push(callItem);
    }

    emit({
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: modelId,
        status,
        incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
        output,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          input_tokens_details: { cached_tokens: cachedTokens },
          output_tokens_details: { reasoning_tokens: reasoningTokens }
        }
      }
    });
  };

  const fakeRes = new Writable({
    write(chunk, _encoding, callback) {
      try {
        sseBuffer += chunk.toString();
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.substring(6).trim();
          if (dataStr === '[DONE]') continue;
          try {
            absorb(JSON.parse(dataStr));
          } catch {
            // ignore malformed SSE JSON
          }
        }
      } catch {
        // ignore
      }
      callback();
    },
    final(callback) {
      try {
        if (sseBuffer.trim().startsWith('data: ')) {
          const dataStr = sseBuffer.trim().substring(6).trim();
          if (dataStr && dataStr !== '[DONE]') {
            try {
              absorb(JSON.parse(dataStr));
            } catch {
              // ignore
            }
          }
        }
        finalize();
      } catch {
        // ignore
      }
      finish();
      callback();
    }
  }) as ResponsesFakeResponse;

  fakeRes.statusCode = 200;
  fakeRes.setHeader = () => fakeRes;
  fakeRes.status = (code: number) => {
    fakeRes.statusCode = code;
    return fakeRes;
  };
  fakeRes.json = (data: any) => {
    if (fakeRes.statusCode >= 400 || data?.error) {
      emit({
        type: 'response.failed',
        response_id: responseId,
        error: data?.error || { message: 'Upstream request failed', type: 'upstream_error' }
      });
    } else {
      const responsesEnvelope = chatCompletionToResponsesResponse(data, modelId);
      if (!itemAdded) {
        const choice = data.choices?.[0] || {};
        const message = choice.message || {};
        // Same ordering rule as the streaming path: a reasoning item, when the
        // envelope carries one, takes the first slot so the answer does not
        // collide with it.
        const envelopeReasoning = (responsesEnvelope.output || []).find((item: any) => item.type === 'reasoning');
        if (envelopeReasoning) {
          const reasoningIndex = allocateOutputIndex();
          emit({
            type: 'response.output_item.added',
            response_id: responseId,
            output_index: reasoningIndex,
            item: envelopeReasoning
          });
        }
        const index = allocateOutputIndex();
        messageOutputIndex = index;
        itemAdded = true;
        emit({
          type: 'response.output_item.added',
          response_id: responseId,
          output_index: index,
          item: {
            id: outputItemMsgId,
            type: 'message',
            status: 'completed',
            role: message.role || 'assistant',
            content: [{ type: 'output_text', text: message.content || '' }]
          }
        });
      }
      emit({
        type: 'response.completed',
        response: responsesEnvelope
      });
    }
    finish();
  };

  return fakeRes;
}
