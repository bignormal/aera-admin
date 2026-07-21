import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Form, Input, Select } from 'antd';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import type { ReasonInput } from '../api/contracts';

const options = {
  account: [
    { value: 'customer_request', label: '客户请求' },
    { value: 'policy_violation', label: '违反使用政策' },
    { value: 'account_recovery', label: '账号恢复' },
    { value: 'suspected_compromise', label: '疑似凭证泄露' },
    { value: 'security_incident', label: '安全事件处置' },
  ],
  device: [
    { value: 'lost_device', label: '设备遗失' },
    { value: 'device_replacement', label: '设备更换' },
    { value: 'suspected_compromise', label: '疑似凭证泄露' },
    { value: 'security_incident', label: '安全事件处置' },
  ],
  session: [
    { value: 'session_cleanup', label: '会话安全清理' },
    { value: 'suspected_compromise', label: '疑似凭证泄露' },
    { value: 'security_incident', label: '安全事件处置' },
  ],
} as const;

export type ReasonCategory = keyof typeof options;

const ticketPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const sensitiveText =
  /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?86[- ]?)?1[3-9]\d{9}|bearer\s+\S+|(?:password|secret|token|cookie)\s*[:=]\s*\S{6,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;

function schemaFor(category: ReasonCategory) {
  const allowed = new Set<string>(options[category].map((item) => item.value));
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
  category: ReasonCategory;
  submitLabel: string;
  pending?: boolean;
  onSubmit: (value: ReasonInput) => void | Promise<void>;
}

export function ReasonForm({ category, submitLabel, pending = false, onSubmit }: ReasonFormProps) {
  const schema = schemaFor(category);
  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<ReasonInput>({
    resolver: zodResolver(schema),
    defaultValues: { reason_code: '', ticket_reference: '', note: '' },
  });

  return (
    <Form
      component="form"
      className="reason-form-grid"
      layout="vertical"
      onFinish={handleSubmit(onSubmit)}
    >
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
            <Select {...field} id="reason-code" options={[...options[category]]} />
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
      <Button type="primary" htmlType="submit" danger loading={pending}>
        {submitLabel}
      </Button>
    </Form>
  );
}
