import {z} from 'zod';

const ResumeSignalSchema = z.object({
    type: z.literal('signal'),
    action: z.literal('resume_audio')
});

const InterruptSignalSchema = z.object({
    type: z.literal('signal'),
    action: z.literal('interrupt_audio')
});

const AudioStartSchema = z.object({
    type: z.literal('audio_start'),
    sample_rate: z.number().int().positive(),
    channels: z.number().int().min(1).max(2),
    sample_width: z.literal(2)
});

const AudioEndSchema = z.object({
    type: z.literal('audio_end')
});

const AudioAbortSchema = z.object({
  type: z.literal('audio_abort')
});

const SentenceAudioEndSchema = z.object({
  type: z.literal('sentence_audio_end')
});

const AgentMessageSchema = z.discriminatedUnion('type', [
    AudioStartSchema,
    AudioEndSchema,
    AudioAbortSchema,
    SentenceAudioEndSchema,
]);

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export type ParsedAgentMessage =
  | { success: true; data: AgentMessage }
  | { success: false; error: 'invalid_json' | 'invalid_schema'; cause: unknown };

export function parseAgentMessage(raw: string): ParsedAgentMessage {
    let json: unknown;
        try {
          json = JSON.parse(raw);
        }catch(cause){
          return {success: false, error: 'invalid_json', cause};
        }
        const parserResult = AgentMessageSchema.safeParse(json);
        if (!parserResult.success) {    
          return {success: false, error: 'invalid_schema', cause: parserResult.error};
        }
        return {success: true, data: parserResult.data};
}

export { ResumeSignalSchema, InterruptSignalSchema };
