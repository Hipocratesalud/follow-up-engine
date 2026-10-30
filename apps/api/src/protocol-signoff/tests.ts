import type { ItemTestRefs, SignoffTestCatalog } from './model.ts';

/**
 * The exact tests that prove each sign-off point, by protocol id and item
 * key. `generate.test.ts` asserts every `describe`/`it` title named here is
 * literally present in `file` (byte for byte), so a rename anywhere breaks
 * the build instead of silently leaving a page citing a test that no
 * longer exists.
 */
const FILE = 'packages/acceptance/test/protocol-signoff.test.ts';

const DIABETES_FIRES = 'diabetes protocol: every listed point fires, due the day the config says';
const DIABETES_EXCEPTIONS = 'diabetes protocol: every listed exception suppresses the item';
const HYPERTENSION_FIRES =
  'hypertension protocol: every listed point fires, due the day the config says';
const HYPERTENSION_EXCEPTIONS = 'hypertension protocol: every listed exception suppresses the item';

const DIABETES: Readonly<Record<string, ItemTestRefs>> = {
  visit: {
    fires: {
      file: FILE,
      describe: DIABETES_FIRES,
      it: 'protocol_diabetes_visit fires 180 days after enrollment, then 180 days after the next visit',
    },
    exceptions: [],
  },
  hba1c: {
    fires: {
      file: FILE,
      describe: DIABETES_FIRES,
      it: 'protocol_diabetes_hba1c fires 90 days after enrollment, then 90 days after the last HbA1c',
    },
    exceptions: [
      {
        id: 'covered_by_plan',
        test: {
          file: FILE,
          describe: DIABETES_EXCEPTIONS,
          it: 'protocol_diabetes_hba1c covered_by_plan: an open HbA1c order suppresses the protocol item',
        },
      },
    ],
  },
  lipids: {
    fires: {
      file: FILE,
      describe: DIABETES_FIRES,
      it: 'protocol_diabetes_lipids fires 365 days after enrollment, then 365 days after the last panel',
    },
    exceptions: [
      {
        id: 'covered_by_protocol',
        test: {
          file: FILE,
          describe: DIABETES_EXCEPTIONS,
          it: 'protocol_diabetes_lipids covered_by_protocol: dyslipidemia expects the same panel no later',
        },
      },
    ],
  },
  fundus: {
    fires: {
      file: FILE,
      describe: DIABETES_FIRES,
      it: 'protocol_diabetes_fundus fires 365 days after enrollment, then 365 days after the eye exam',
    },
    exceptions: [],
  },
};

const HYPERTENSION: Readonly<Record<string, ItemTestRefs>> = {
  visit: {
    fires: {
      file: FILE,
      describe: HYPERTENSION_FIRES,
      it: 'protocol_hypertension_visit fires 180 days after enrollment, then 180 days after the next visit',
    },
    exceptions: [],
  },
  labs: {
    fires: {
      file: FILE,
      describe: HYPERTENSION_FIRES,
      it: 'protocol_hypertension_labs fires 365 days after enrollment, then 365 days after the last result',
    },
    exceptions: [
      {
        id: 'covered_by_plan',
        test: {
          file: FILE,
          describe: HYPERTENSION_EXCEPTIONS,
          it: 'protocol_hypertension_labs covered_by_plan: an open creatinine order suppresses the protocol item',
        },
      },
      {
        id: 'covered_by_protocol',
        test: {
          file: FILE,
          describe: HYPERTENSION_EXCEPTIONS,
          it: 'protocol_hypertension_labs covered_by_protocol: chronic kidney disease expects creatinine no later',
        },
      },
    ],
  },
};

export const SIGNOFF_TESTS: SignoffTestCatalog = {
  diabetes: DIABETES,
  hypertension: HYPERTENSION,
};
