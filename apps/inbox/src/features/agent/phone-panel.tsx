import {
  Check,
  CheckCheck,
  Image as ImageIcon,
  Mic,
  Paperclip,
  Send,
  TriangleAlert,
} from 'lucide-react';
import {
  type ChangeEvent,
  type SyntheticEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { AgentConversationSummary, AgentMessageView } from '../../api/agent-contract.ts';
import {
  useAgentMediaUrl,
  useFixPhone,
  useSendPatientMessage,
  useSetDelivery,
} from '../../api/agent-queries.ts';
import { InlineError } from '../../components/states.tsx';
import { Button, Card, INPUT_CLASS, Spinner } from '../../components/ui.tsx';
import { useLocale, useT } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { clinicDate, clinicTime } from './format.ts';
import { STORY_REPLIES } from './story-replies.ts';

function Ticks({ status }: { readonly status: AgentMessageView['deliveryStatus'] }): ReactNode {
  const t = useT();
  const label = status === undefined ? '' : (t.agent.phone.statuses[status] ?? status);
  if (status === 'undelivered') {
    return <TriangleAlert aria-label={label} className="size-3.5 text-danger" />;
  }
  if (status === 'sent') return <Check aria-label={label} className="size-3.5 text-subtle" />;
  return (
    <CheckCheck
      aria-label={label}
      className={cx('size-3.5', status === 'read' ? 'text-info' : 'text-subtle')}
    />
  );
}

function MediaPreview({ message }: { readonly message: AgentMessageView }): ReactNode {
  const t = useT();
  const url = useAgentMediaUrl(message.media?.id);
  if (message.kind === 'image') {
    return (
      <div className="flex flex-col gap-1">
        <span className="inline-flex items-center gap-1 text-xs text-muted">
          <ImageIcon className="size-3.5" aria-hidden="true" />
          {t.agent.phone.photo}
        </span>
        {url === undefined ? (
          <span className="skeleton h-28 w-44 rounded-md" aria-hidden="true" />
        ) : (
          <img src={url} alt={t.agent.phone.photoAlt} className="max-h-48 w-auto rounded-md" />
        )}
        {message.reading === undefined ? (
          <span className="text-xs text-muted">{t.agent.phone.reading}</span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-1 text-xs text-muted">
        <Mic className="size-3.5" aria-hidden="true" />
        {t.agent.phone.voiceNote}
      </span>
      {url === undefined ? null : <audio controls src={url} className="h-8 w-56" />}
      <span className="text-xs text-muted">
        {message.transcript === undefined
          ? t.agent.phone.transcribing
          : `${t.agent.phone.transcriptLabel}: ${message.transcript}`}
      </span>
    </div>
  );
}

function DeliveryActions({ message }: { readonly message: AgentMessageView }): ReactNode {
  const t = useT();
  const setDelivery = useSetDelivery();
  function markRead(): void {
    setDelivery.mutate({ messageId: message.id, status: 'read' });
  }
  function markUndelivered(): void {
    setDelivery.mutate({ messageId: message.id, status: 'undelivered' });
  }
  if (message.deliveryStatus === 'undelivered') return null;
  return (
    <div
      role="group"
      aria-label={t.agent.phone.statusActions}
      className="mt-1 flex flex-wrap justify-end gap-1"
    >
      {message.deliveryStatus === 'read' ? null : (
        <button
          type="button"
          onClick={markRead}
          className="rounded px-1.5 py-0.5 text-[11px] text-info hover:bg-info-soft"
        >
          {t.agent.phone.markRead}
        </button>
      )}
      <button
        type="button"
        onClick={markUndelivered}
        className="rounded px-1.5 py-0.5 text-[11px] text-danger hover:bg-danger-soft"
      >
        {t.agent.phone.markUndelivered}
      </button>
    </div>
  );
}

function Bubble({
  message,
  timeZone,
}: {
  readonly message: AgentMessageView;
  readonly timeZone: string | undefined;
}): ReactNode {
  const t = useT();
  const locale = useLocale();
  const outbound = message.direction === 'outbound';
  return (
    <li className={cx('flex', outbound ? 'justify-start' : 'justify-end')}>
      <div
        className={cx(
          'max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-snug shadow-card',
          outbound ? 'rounded-tl-sm bg-surface text-fg' : 'rounded-tr-sm bg-success-soft text-fg',
        )}
      >
        {message.kind === 'text' ? null : <MediaPreview message={message} />}
        {message.text === '' || message.kind === 'voice' ? null : (
          <p className="whitespace-pre-line">{message.text}</p>
        )}
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-subtle">
          <span>{clinicTime(message.at, timeZone, locale)}</span>
          {outbound ? <Ticks status={message.deliveryStatus} /> : null}
          {outbound && message.deliveryStatus !== undefined ? (
            <span className="sr-only">{t.agent.phone.statuses[message.deliveryStatus]}</span>
          ) : null}
        </div>
        {outbound ? <DeliveryActions message={message} /> : null}
      </div>
    </li>
  );
}

function SuggestionChip({
  text,
  onPick,
  disabled,
}: {
  readonly text: string;
  readonly onPick: (text: string) => void;
  readonly disabled: boolean;
}): ReactNode {
  function handleClick(): void {
    onPick(text);
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={handleClick}
      className="rounded-full border border-border-strong bg-surface px-2.5 py-1 text-left text-xs text-fg hover:bg-surface-2 disabled:opacity-60"
    >
      {text}
    </button>
  );
}

/**
 * The simulated WhatsApp phone: the evaluator plays María (types, sends a
 * voice note or a photo) and plays the channel (marks a message read or
 * undelivered). Everything goes through the API: the agent answers in the
 * console beside it.
 */
export function PhonePanel({
  conversation,
  messages,
  timeZone,
}: {
  readonly conversation: AgentConversationSummary;
  readonly messages: readonly AgentMessageView[];
  readonly timeZone: string | undefined;
}): ReactNode {
  const t = useT();
  const locale = useLocale();
  const [draft, setDraft] = useState('');
  const send = useSendPatientMessage(conversation.patientId);
  const fixPhone = useFixPhone(conversation.patientId);
  const voiceInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages.length, conversation.busy]);

  function handleDraft(event: ChangeEvent<HTMLInputElement>): void {
    setDraft(event.target.value);
  }
  function handleSubmit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = draft.trim();
    if (text === '') return;
    send.mutate({ kind: 'text', text, source: 'typed' }, { onSuccess: clearDraft });
  }
  function clearDraft(): void {
    setDraft('');
  }
  function pickSuggestion(text: string): void {
    send.mutate({ kind: 'text', text, source: 'suggested' });
  }
  function sendSampleVoice(): void {
    send.mutate({ kind: 'sample', sample: 'voice_note' });
  }
  function sendSamplePhoto(): void {
    send.mutate({ kind: 'sample', sample: 'lab_report' });
  }
  function openVoicePicker(): void {
    voiceInput.current?.click();
  }
  function openPhotoPicker(): void {
    photoInput.current?.click();
  }
  function handleFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file !== undefined) send.mutate({ kind: 'file', file });
  }
  function handleFixPhone(): void {
    fixPhone.mutate();
  }

  const stopped = conversation.status === 'opted_out';
  return (
    <Card className="flex h-[720px] flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-border bg-success px-4 py-3 text-primary-fg">
        <span className="grid size-9 place-items-center rounded-full bg-surface/20 text-sm font-semibold">
          {t.agent.phone.contact.slice(0, 1)}
        </span>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold">{t.agent.phone.contact}</p>
          <p className="truncate text-xs opacity-90">
            {conversation.busy ? t.agent.phone.working : t.agent.phone.subtitle}
          </p>
        </div>
        <span className="ml-auto text-xs opacity-90">{t.agent.phone.title}</span>
      </header>

      {conversation.phoneStatus === 'undelivered' ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-danger-soft px-4 py-2 text-xs text-danger">
          <span className="flex-1">{t.agent.phone.undeliveredBanner}</span>
          <Button size="sm" onClick={handleFixPhone} loading={fixPhone.isPending}>
            {t.agent.phone.fixPhone}
          </Button>
        </div>
      ) : null}
      {stopped ? (
        <p className="border-b border-border bg-warning-soft px-4 py-2 text-xs text-warning">
          {t.agent.phone.optedOutBanner}
        </p>
      ) : null}
      {conversation.status === 'done' ? (
        <p className="border-b border-border bg-success-soft px-4 py-2 text-xs text-success">
          {t.agent.phone.doneBanner}
        </p>
      ) : null}
      {conversation.status === 'unreachable' ? (
        <p className="border-b border-border bg-warning-soft px-4 py-2 text-xs text-warning">
          {conversation.flagAtNextContact
            ? t.agent.phone.flagBanner
            : t.agent.phone.unreachableBanner(
                conversation.retryAt === undefined
                  ? ''
                  : clinicDate(conversation.retryAt, timeZone, locale),
              )}
        </p>
      ) : null}

      <ol ref={list} className="flex flex-1 flex-col gap-2 overflow-y-auto bg-surface-2 px-3 py-3">
        {messages.length === 0 ? (
          <li className="m-auto text-xs text-muted">{t.agent.phone.empty}</li>
        ) : (
          messages.map((message) => (
            <Bubble key={message.id} message={message} timeZone={timeZone} />
          ))
        )}
        {conversation.busy ? (
          <li className="flex items-center gap-2 text-xs text-muted">
            <Spinner className="size-3" />
            {t.agent.phone.working}
          </li>
        ) : null}
      </ol>

      <div className="flex flex-col gap-2 border-t border-border bg-surface px-3 py-3">
        <p className="text-[11px] font-medium text-muted">{t.agent.phone.suggested}</p>
        <div className="flex flex-wrap gap-1.5">
          {STORY_REPLIES[conversation.language].map((text) => (
            <SuggestionChip
              key={text}
              text={text}
              onPick={pickSuggestion}
              disabled={send.isPending || stopped}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.agent.phone.attachments}>
          <Button
            size="sm"
            icon={<Mic className="size-3.5" aria-hidden="true" />}
            onClick={sendSampleVoice}
            disabled={send.isPending || stopped}
          >
            {t.agent.phone.sampleVoice}
          </Button>
          <Button
            size="sm"
            icon={<ImageIcon className="size-3.5" aria-hidden="true" />}
            onClick={sendSamplePhoto}
            disabled={send.isPending || stopped}
          >
            {t.agent.phone.samplePhoto}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Paperclip className="size-3.5" aria-hidden="true" />}
            onClick={openVoicePicker}
            disabled={send.isPending || stopped}
          >
            {t.agent.phone.uploadVoice}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Paperclip className="size-3.5" aria-hidden="true" />}
            onClick={openPhotoPicker}
            disabled={send.isPending || stopped}
          >
            {t.agent.phone.uploadPhoto}
          </Button>
          <input
            ref={voiceInput}
            type="file"
            accept="audio/wav,.wav"
            className="hidden"
            onChange={handleFile}
          />
          <input
            ref={photoInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleFile}
          />
        </div>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            value={draft}
            onChange={handleDraft}
            placeholder={t.agent.phone.placeholder}
            aria-label={t.agent.phone.placeholder}
            disabled={stopped}
            className={INPUT_CLASS}
          />
          <Button
            type="submit"
            variant="primary"
            loading={send.isPending}
            disabled={stopped}
            aria-label={t.agent.phone.send}
            icon={<Send className="size-4" aria-hidden="true" />}
          />
        </form>
        {send.isError ? <InlineError error={send.error} /> : null}
      </div>
    </Card>
  );
}
