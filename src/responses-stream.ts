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

  const finish = () => {
    onFinished?.();
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
            const data = JSON.parse(dataStr);
            const choice = data.choices?.[0] || {};
            const delta = choice.delta || {};

            if (!itemAdded) {
              emit({
                type: 'response.output_item.added',
                response_id: responseId,
                output_index: 0,
                item: {
                  id: outputItemMsgId,
                  type: 'message',
                  status: 'in_progress',
                  role: delta.role || 'assistant',
                  content: []
                }
              });
              itemAdded = true;
            }

            if (delta.content) {
              emit({
                type: 'response.output_text.delta',
                response_id: responseId,
                item_id: outputItemMsgId,
                content_index: 0,
                delta: delta.content
              });
            }

            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
              for (const tc of delta.tool_calls) {
                emit({
                  type: 'response.output_tool_call.arguments.delta',
                  response_id: responseId,
                  item_id: tc.id || `call_${cryptoRandomId()}`,
                  delta: tc.function?.arguments || ''
                });
              }
            }
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
              const data = JSON.parse(dataStr);
              const choice = data.choices?.[0] || {};
              const delta = choice.delta || {};
              if (delta.content) {
                emit({
                  type: 'response.output_text.delta',
                  response_id: responseId,
                  item_id: outputItemMsgId,
                  content_index: 0,
                  delta: delta.content
                });
              }
            } catch {
              // ignore
            }
          }
        }
        if (itemAdded) {
          emit({
            type: 'response.output_item.done',
            response_id: responseId,
            output_index: 0,
            item: {
              id: outputItemMsgId,
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: '' }]
            }
          });
        }
        emit({
          type: 'response.completed',
          response: {
            id: responseId,
            object: 'response',
            status: 'completed',
            model: modelId,
            output: itemAdded
              ? [{ id: outputItemMsgId, type: 'message', role: 'assistant', status: 'completed' }]
              : []
          }
        });
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
