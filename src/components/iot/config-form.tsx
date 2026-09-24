"use client";

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateConfig, type ConfigErrors } from "@/lib/config-validation";
import type { DeviceDTO } from "@/lib/iot-contracts";

type Field = "tempOn" | "tempOff" | "heartbeatIntervalSec";

const FIELDS: { key: Field; label: string; hint: string; step: number }[] = [
  { key: "tempOn", label: "Fan ON at ≥ (°C)", hint: "Auto mode: turn on at or above", step: 0.5 },
  { key: "tempOff", label: "Fan OFF at ≤ (°C)", hint: "Auto mode: turn off at or below", step: 0.5 },
  { key: "heartbeatIntervalSec", label: "Heartbeat (s)", hint: "Telemetry interval, 5–300", step: 1 },
];

/** Settings form for auto-mode thresholds and heartbeat interval, with inline validation. */
export function ConfigForm({ device }: { device: DeviceDTO }) {
  const server = {
    tempOn: String(device.tempOn),
    tempOff: String(device.tempOff),
    heartbeatIntervalSec: String(device.heartbeatIntervalSec),
  };
  const [values, setValues] = useState<Record<Field, string>>(server);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState<ConfigErrors>({});

  // Follow live device:config broadcasts unless the user is mid-edit.
  useEffect(() => {
    if (!dirty) setValues(server);
  }, [device.tempOn, device.tempOff, device.heartbeatIntervalSec]);

  const parsed = {
    tempOn: values.tempOn.trim() === "" ? NaN : Number(values.tempOn),
    tempOff: values.tempOff.trim() === "" ? NaN : Number(values.tempOff),
    heartbeatIntervalSec: values.heartbeatIntervalSec.trim() === "" ? NaN : Number(values.heartbeatIntervalSec),
  };
  const errors: ConfigErrors = { ...validateConfig(parsed), ...(dirty ? serverErrors : {}) };
  const hasErrors = Object.keys(errors).length > 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (hasErrors) return;
    setSaving(true);
    setServerErrors({});
    try {
      const res = await fetch(`/api/devices/${device.id}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setServerErrors(data?.fields ?? {});
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }
      setDirty(false);
      toast.success(`Settings saved for ${device.name}`, {
        description: data?.deviceOnline ? "Pushed to the device." : "The device will get them when it reconnects.",
      });
    } catch (err) {
      toast.error("Could not save settings", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-3">
        {FIELDS.map((f) => (
          <div key={f.key} className="space-y-1">
            <Label htmlFor={`${device.id}-${f.key}`} className="text-xs">
              {f.label}
            </Label>
            <Input
              id={`${device.id}-${f.key}`}
              type="number"
              inputMode="decimal"
              step={f.step}
              value={values[f.key]}
              aria-invalid={!!errors[f.key]}
              className={errors[f.key] ? "border-rose-500" : undefined}
              onChange={(e) => {
                setDirty(true);
                setServerErrors({});
                setValues((v) => ({ ...v, [f.key]: e.target.value }));
              }}
            />
            {errors[f.key] ? (
              <p className="text-[11px] text-rose-600" role="alert">
                {errors[f.key]}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">{f.hint}</p>
            )}
          </div>
        ))}
      </div>
      <Button type="submit" size="sm" disabled={!dirty || hasErrors || saving}>
        {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
        Save settings
      </Button>
    </form>
  );
}
