import {z} from 'zod';

const StopSignalSchema = z.object({
    type: z.literal('signal'),
    action: z.literal('stop_audio')
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

const AgentMessageSchema = z.discriminatedUnion('type', [
    AudioStartSchema,
    AudioEndSchema,
]);

export { StopSignalSchema, AudioStartSchema, AudioEndSchema, AgentMessageSchema };