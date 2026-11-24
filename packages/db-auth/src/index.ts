// `@repo/db-auth` public surface: DB_AUTH parsing and RDS IAM token minting (`./rdsIam`).
export {
  type DbAuthMode,
  type IamTarget,
  type SignerFactory,
  type TokenSigner,
  assertIamEnvironment,
  awsRegionFromEnv,
  createIamTokenSource,
  iamTargetFromUrl,
  parseDbAuthMode,
} from "./rdsIam";
