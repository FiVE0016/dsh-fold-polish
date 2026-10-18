import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  migrateSettings,
  shouldFold,
} from '../src/fold.js'

test('fresh preferences default to three lines on both sides', () => {
  assert.equal(DEFAULT_SETTINGS.userLines, 3)
  assert.equal(DEFAULT_SETTINGS.assistantLines, 3)
  for (const value of [null, undefined, '', [], 'junk'])
    assert.deepEqual(normalizeSettings(value), DEFAULT_SETTINGS)
})
test('invalid storage values cannot inject CSS or invalid geometry', () => {
  const value = normalizeSettings({
    userLines: '5px',
    assistantLines: NaN,
    rightbarRatio: 1000,
    collapsedLines: 0,
    extraPx: -2,
    enabled: 'false',
    unknown: 'ignored',
  })
  assert.equal(value.userLines, 3)
  assert.equal(value.assistantLines, 3)
  assert.equal(value.rightbarRatio, 70)
  assert.equal(value.collapsedLines, 1)
  assert.equal(value.extraPx, 0)
  assert.equal(value.enabled, true)
  assert.equal('unknown' in value, false)
})
test('numeric edits round, clamp and preserve booleans', () => {
  const value = normalizeSettings({
    userLines: '4.8',
    assistantLines: 999,
    rightbarRatio: '35',
    keepLatestOpen: false,
  })
  assert.equal(value.userLines, 5)
  assert.equal(value.assistantLines, 120)
  assert.equal(value.rightbarRatio, 35)
  assert.equal(value.keepLatestOpen, false)
})
test('legacy defaults migrate once while custom line choices survive', () => {
  assert.equal(
    migrateSettings({ userLines: 6, assistantLines: 10 }).userLines,
    3,
  )
  assert.equal(
    migrateSettings({ userLines: 6, assistantLines: 10 }).assistantLines,
    3,
  )
  assert.equal(
    migrateSettings({ userLines: 7, assistantLines: 8 }).userLines,
    7,
  )
  assert.equal(migrateSettings({ schemaVersion: 1, userLines: 6 }).userLines, 6)
})

test('restore original icon buttons once without overriding later label choices', () => {
  assert.equal(DEFAULT_SETTINGS.stepLabels, false)
  assert.equal(
    migrateSettings({ schemaVersion: 1, stepLabels: true }).stepLabels,
    false,
  )
  assert.equal(
    migrateSettings({ schemaVersion: 2, stepLabels: true }).stepLabels,
    true,
  )
  assert.equal(migrateSettings({ stepLabels: true }).stepLabels, true)
})
test('collapse-all overrides latest policy, while explicit reader choice survives', () => {
  const input = {
    totalLines: 20,
    budget: 3,
    enabled: true,
    streaming: false,
    latest: true,
    settings: DEFAULT_SETTINGS,
  }
  assert.equal(shouldFold(input), false)
  assert.equal(
    shouldFold({
      ...input,
      settings: { ...DEFAULT_SETTINGS, collapseAll: true },
    }),
    true,
  )
  assert.equal(shouldFold({ ...input, latest: false }), true)
  assert.equal(shouldFold({ ...input, choice: false }), true)
  assert.equal(shouldFold({ ...input, latest: false, choice: true }), false)
})
test('short, streaming and disabled messages always preserve the live source', () => {
  const input = {
    totalLines: 20,
    budget: 3,
    enabled: true,
    streaming: false,
    latest: false,
    settings: DEFAULT_SETTINGS,
  }
  assert.equal(shouldFold({ ...input, totalLines: 3 }), false)
  assert.equal(shouldFold({ ...input, streaming: true }), false)
  assert.equal(shouldFold({ ...input, enabled: false }), false)
})
