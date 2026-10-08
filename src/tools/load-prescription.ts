import type TonalClient from '@dlwiest/ts-tonal-client';
import type { MCPResponse } from '../types/index.js';
import { handleToolError, TonalMCPError } from '../utils/error-handler.js';
import { convertPoundsToPercentage, type WeightConversion } from '../utils/load-calibration.js';
import { resolveLoadReference } from '../utils/load-reference.js';
import {
  formatConvertTargetWeightReport,
  formatLoadReferenceReport,
} from '../utils/load-report.js';
import { validateRequiredString } from '../utils/validation.js';

/** Accepts one target or an array of them, so a whole exercise converts in a single call. */
function validateTargetPounds(value: unknown): number[] {
  const candidates = Array.isArray(value) ? value : [value];

  if (candidates.length === 0) {
    throw new TonalMCPError(
      'targetPounds must contain at least one target',
      'VALIDATION_ERROR',
      400
    );
  }

  return candidates.map((candidate, index) => {
    const label = Array.isArray(value) ? `targetPounds[${index}]` : 'targetPounds';
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      throw new TonalMCPError(`${label} must be a finite number`, 'VALIDATION_ERROR', 400);
    }
    if (candidate < 0) {
      throw new TonalMCPError(
        `${label} must be greater than or equal to 0; a negative weightPercentage is invalid`,
        'VALIDATION_ERROR',
        400
      );
    }
    return candidate;
  });
}

function validateOptionalLookback(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : (value as number);
}

export async function getLoadReference(
  client: TonalClient,
  args?: Record<string, unknown>
): Promise<MCPResponse> {
  try {
    const movementName = validateRequiredString(args?.movementName, 'movementName');
    const reference = await resolveLoadReference(client, movementName, {
      lookbackActivities: validateOptionalLookback(args?.lookbackActivities),
    });

    return {
      content: [{ type: 'text' as const, text: formatLoadReferenceReport(reference) }],
    };
  } catch (error) {
    return handleToolError(error, 'get_load_reference');
  }
}

export async function convertTargetWeight(
  client: TonalClient,
  args?: Record<string, unknown>
): Promise<MCPResponse> {
  try {
    const movementName = validateRequiredString(args?.movementName, 'movementName');
    const targets = validateTargetPounds(args?.targetPounds);
    const reference = await resolveLoadReference(client, movementName, {
      lookbackActivities: validateOptionalLookback(args?.lookbackActivities),
    });

    const conversions: WeightConversion[] = targets.map((target) =>
      convertPoundsToPercentage(target, reference)
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatConvertTargetWeightReport(reference, conversions),
        },
      ],
    };
  } catch (error) {
    return handleToolError(error, 'convert_target_weight');
  }
}
