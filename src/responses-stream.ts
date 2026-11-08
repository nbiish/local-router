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
  let itemAdded = false;
  let sseBuffer = '';
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = '';
  // Tool calls stream in as fragments keyed by index. A Responses client reads
  // each one as its own `function_call` output item — an event name of our own
  // invention (`response.output_tool_call.arguments.delta`) is not in the
  // Responses vocabulary, so Codex silently dropped every tool call and hung
  // waiting for an item that never arrived.
  const toolCalls = new Map<number, { id: string; callId: string; name: string; args: string; added: boolean }>();
  // The assistant message owns output_index 0 and tool calls follow it, so an
  // index is fixed at the moment an item is announced and its deltas always
  // address the same slot.
  const toolIndex = (position: number) => position + 1;

  const finish = () => {
    onFinished?.();
  };

  const ensureItem = (role?: string) => {
    if (itemAdded) return;
    itemAdded = true;
    emit({
      type: 'response.output_item.added',
      response_id: responseId,
      output_index: 0,
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

    const choice = data?.choices?.[0] || {};
    const delta = choice.delta || {};
    if (choice.finish_reason) finishReason = String(choice.finish_reason);

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
            added: false
          };
          toolCalls.set(index, entry);
        }
        if (tc.function?.name) entry.name = tc.function.name;
        // OpenAI streams the call id on the first fragment only; keep the first
        // one we see so the emitted function_call item and its deltas agree.
        if (tc.id && !entry.added) entry.callId = tc.id;

        if (!entry.added) {
          entry.added = true;
          emit({
            type: 'response.output_item.added',
            response_id: responseId,
            output_index: toolIndex(index),
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
            output_index: toolIndex(index),
            delta: fragment
          });
        }
      }
    }
  };

  const finalize = () => {
    const status = finishReason === 'length' ? 'incomplete' : 'completed';
    const content = [{ type: 'output_text', text, annotations: [] }];

    // Codex reads the terminal item/response content, not just the deltas: an
    // empty `output_text` here shows the turn as successful with no answer.
    // With tool calls present the text item is only emitted when it carries
    // content, so the terminal output stays in the order it streamed.
    const output: any[] = [];
    if (text) {
      emit({
        type: 'response.output_text.done',
        response_id: responseId,
        item_id: outputItemMsgId,
        output_index: 0,
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
        output_index: 0,
        item: messageItem
      });
      output.push(messageItem);
    }

    const orderedTools = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [position, entry] of orderedTools) {
      const index = toolIndex(position);
      emit({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        item_id: entry.id,
        output_index: index,
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
        output_index: index,
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
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 }
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
        emit({
          type: 'response.output_item.added',
          response_id: responseId,
          output_index: 0,
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
