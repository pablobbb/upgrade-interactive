// Typed identity helpers for hand-built fixtures.
//
// A test usually builds only the fields the code under test reads. Wrapping the
// object in one of these says which shape it stands in for, so the fields it does
// set are checked by name and type, and a misspelled field fails the typecheck.
// Nothing is filled in: each returns its argument unchanged, so the test exercises
// exactly the data it wrote.

/**
 * @import {
 *   DeepPartial, Descriptor, Entry, InstalledTree, PinInstance, Suggestion, Vuln,
 * } from '../src/types.js'
 */

/**
 * @param {DeepPartial<Vuln>} vuln
 * @returns {Vuln}
 */
export const vulnFixture = (vuln) => /** @type {Vuln} */ (vuln);

/**
 * @param {DeepPartial<PinInstance>} instance
 * @returns {PinInstance}
 */
export const instanceFixture = (instance) => /** @type {PinInstance} */ (instance);

/**
 * @param {DeepPartial<Descriptor>} descriptor
 * @returns {Descriptor}
 */
export const descriptorFixture = (descriptor) => /** @type {Descriptor} */ (descriptor);

/**
 * @param {DeepPartial<Entry>} entry
 * @returns {Entry}
 */
export const entryFixture = (entry) => /** @type {Entry} */ (entry);

/**
 * @param {DeepPartial<Suggestion>} suggestion
 * @returns {Suggestion}
 */
export const suggestionFixture = (suggestion) => /** @type {Suggestion} */ (suggestion);

/**
 * @param {DeepPartial<InstalledTree>} tree
 * @returns {InstalledTree}
 */
export const treeFixture = (tree) => /** @type {InstalledTree} */ (tree);
