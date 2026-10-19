import { useId } from 'react';
import type * as React from 'react';
import { Label } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/** Props the field passes to its control so label, help and errors are wired up. */
export interface FormFieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  required?: boolean;
}

export interface FormFieldProps {
  label: string;
  description?: React.ReactNode;
  /** Validation message. Never echo the submitted value if it may be sensitive. */
  error?: string;
  required?: boolean;
  /** Explicit control id; generated when omitted. */
  id?: string;
  className?: string;
  children: (control: FormFieldControlProps) => React.ReactNode;
}

/**
 * Label + control + help text + error, with ids and ARIA wired automatically:
 *
 *   <FormField label="Name" error={errors.name}>
 *     {(control) => <Input {...control} />}
 *   </FormField>
 */
export function FormField({
  label,
  description,
  error,
  required = false,
  id,
  className,
  children,
}: FormFieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={controlId}>
        {label}
        {required ? (
          <>
            <span aria-hidden="true" className="ml-0.5 text-danger">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : null}
      </Label>
      {children({
        id: controlId,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true as const } : {}),
        ...(required ? { required: true } : {}),
      })}
      {description ? (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
