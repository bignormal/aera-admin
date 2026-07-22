import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Form, Input, Select } from 'antd';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { useReasonCodes } from '../api/settings';
import type { ReasonInput, ReasonUsage } from '../api/contracts';

const ticketPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const sensitiveText =
  /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?86[- ]?)?1[3-9]\d{9}|bearer\s+\S+|(?:password|secret|token|cookie)\s*[:=]\s*\S{6,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;

function schemaFor(allowed: ReadonlySet<string>) {
  return z
    .object({
      reason_code: z.string().refine((value) => allowed.has(value), '请选择标准原因'),
      ticket_reference: z
        .string()
        .trim()
        .max(128, '工单编号最多 128 字符'),
      note: z.string().trim().max(500, '补充说明最多 500 字符'),
    })
    .superRefine((value, context) => {
      for (const field of ['ticket_reference', 'note'] as const) {
        if (sensitiveText.test(value[field])) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: '请勿填写邮箱、手机号、令牌、Cookie 或私钥',
          });
        }
      }
      if (value.ticket_reference !== '' && !ticketPattern.test(value.ticket_reference)) {
        context.addIssue({
          code: 'custom',
          path: ['ticket_reference'],
          message: '工单编号格式无效',
        });
      }
    });
}

interface ReasonFormProps {
  usage: ReasonUsage;
  submitLabel: string;
  pending?: boolean;
  onSubmit: (value: ReasonInput) => void | Promise<void>;
}

export function ReasonForm({ usage, submitLabel, pending = false, onSubmit }: ReasonFormProps) {
  const catalog = useReasonCodes(usage);
  const activeReasons = (catalog.data?.items ?? []).filter((reason) => reason.active);
  const allowed = new Set(activeReasons.map((reason) => reason.code));
  const schema = schemaFor(allowed);
  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<ReasonInput>({
    resolver: zodResolver(schema),
    defaultValues: { reason_code: '', ticket_reference: '', note: '' },
  });
  const unavailable = catalog.isError;
  const empty = catalog.isSuccess && activeReasons.length === 0;
  const disabled = pending || catalog.isPending || unavailable || empty;

  return (
    <Form
      component="form"
      className="reason-form-grid"
      layout="vertical"
      onFinish={handleSubmit(onSubmit)}
    >
      {unavailable && (
        <Alert type="error" showIcon message="标准原因暂时不可用，当前操作已禁止提交" />
      )}
      {empty && (
        <Alert type="warning" showIcon message="暂无适用于此操作的有效标准原因，当前操作已禁止提交" />
      )}
      <Controller
        control={control}
        name="reason_code"
        render={({ field }) => (
          <Form.Item
            label="标准原因"
            htmlFor="reason-code"
            validateStatus={errors.reason_code ? 'error' : undefined}
            help={errors.reason_code?.message}
          >
            <Select
              {...field}
              id="reason-code"
              loading={catalog.isPending}
              disabled={catalog.isPending || unavailable || empty}
              virtual={false}
              options={activeReasons.map((reason) => ({ value: reason.code, label: reason.label }))}
            />
          </Form.Item>
        )}
      />
      <Controller
        control={control}
        name="ticket_reference"
        render={({ field }) => (
          <Form.Item
            label="工单编号"
            validateStatus={errors.ticket_reference ? 'error' : undefined}
            help={errors.ticket_reference?.message}
          >
            <Input {...field} aria-label="工单编号" maxLength={128} autoComplete="off" />
          </Form.Item>
        )}
      />
      <Controller
        control={control}
        name="note"
        render={({ field }) => (
          <Form.Item
            label="补充说明"
            validateStatus={errors.note ? 'error' : undefined}
            help={errors.note?.message}
          >
            <Input.TextArea
              {...field}
              aria-label="补充说明"
              maxLength={500}
              autoComplete="off"
              rows={3}
            />
          </Form.Item>
        )}
      />
      <Button type="primary" htmlType="submit" danger loading={pending} disabled={disabled}>
        {submitLabel}
      </Button>
    </Form>
  );
}
