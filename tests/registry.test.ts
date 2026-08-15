import assert from 'node:assert/strict';
import test from 'node:test';
import { toolsRegistry } from '../src/tools/registry.js';

test('workout schemas keep block tolerance symmetric and document 1-based output', () => {
  const schemas = ['create_workout', 'update_workout'].map((toolName) => {
    const tool = toolsRegistry.get(toolName);
    assert.ok(tool, `${toolName} must be registered`);
    const properties = tool.inputSchema.properties.exercises.items.properties;

    return {
      toolName,
      setsType: properties.sets.type,
      setsMinimum: properties.sets.minimum,
      blockType: properties.block.type,
      blockMinimum: properties.block.minimum,
      blockDescription: String(properties.block.description),
    };
  });

  assert.equal(schemas[0].blockDescription, schemas[1].blockDescription);
  assert.deepEqual(
    schemas.map(({ blockDescription, ...schema }) => ({
      ...schema,
      explainsOneBasedBlocks: blockDescription.includes('1-based'),
      explainsZeroNormalization:
        blockDescription.includes('supplied 0') &&
        blockDescription.includes('normalized to 1'),
      explainsSupersetGrouping:
        blockDescription.includes('Equal block values') &&
        blockDescription.includes('superset'),
      explainsMixedRenumbering:
        blockDescription.includes('some exercises') &&
        blockDescription.includes('renumbered by first appearance'),
    })),
    [
      {
        toolName: 'create_workout',
        setsType: 'integer',
        setsMinimum: 1,
        blockType: 'integer',
        blockMinimum: 0,
        explainsOneBasedBlocks: true,
        explainsZeroNormalization: true,
        explainsSupersetGrouping: true,
        explainsMixedRenumbering: true,
      },
      {
        toolName: 'update_workout',
        setsType: 'integer',
        setsMinimum: 1,
        blockType: 'integer',
        blockMinimum: 0,
        explainsOneBasedBlocks: true,
        explainsZeroNormalization: true,
        explainsSupersetGrouping: true,
        explainsMixedRenumbering: true,
      },
    ]
  );
});
