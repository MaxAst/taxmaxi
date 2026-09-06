import * as addresses from "./AddressesTable.ts"
import * as assetPrices from "./AssetPricesTable.ts"
import * as assetDecisionRematerializations from "./AssetDecisionRematerializationsTable.ts"
import * as assetRepresentations from "./AssetRepresentationsTable.ts"
import * as assetResolutionDecisionEvidenceLinks from "./AssetResolutionDecisionEvidenceLinksTable.ts"
import * as assetResolutionCurrentState from "./AssetResolutionCurrentStateTable.ts"
import * as assetRepresentationOwnershipDecisions from "./AssetRepresentationOwnershipDecisionsTable.ts"
import * as assetResolutionDecisions from "./AssetResolutionDecisionsTable.ts"
import * as assetResolutionEvidence from "./AssetResolutionEvidenceTable.ts"
import * as assetResolutionJobs from "./AssetResolutionJobsTable.ts"
import * as assets from "./AssetsTable.ts"
import * as blockchains from "./BlockchainsTable.ts"
import * as billing from "./BillingTables.ts"
import * as cex from "./CexTable.ts"
import * as cexAccount from "./CexAccountTable.ts"
import * as calculationRunCorrectionInputs from "./CalculationRunCorrectionInputsTable.ts"
import * as calculationRunResults from "./CalculationRunResultsTables.ts"
import * as calculationRuns from "./CalculationRunsTables.ts"
import * as custodyUnits from "./CustodyUnitsTables.ts"
import * as duneProtocolCandidateObservations from "./DuneProtocolCandidateObservationsTable.ts"
import * as emailVerificationRequests from "./EmailVerificationRequestsTable.ts"
import * as identities from "./IdentitiesTable.ts"
import * as inventoryMovements from "./InventoryMovementsTable.ts"
import * as legalRules from "./LegalRulesTable.ts"
import * as oauthStates from "./OAuthStatesTable.ts"
import * as processingJobDependencies from "./ProcessingJobDependenciesTable.ts"
import * as processingJobs from "./ProcessingJobsTable.ts"
import * as principalClaims from "./PrincipalClaimsTable.ts"
import * as principalAssetOverrideApplications from "./PrincipalAssetOverrideApplicationsTable.ts"
import * as principalAssetOverrides from "./PrincipalAssetOverridesTables.ts"
import * as principalTransactionOverrides from "./PrincipalTransactionOverridesTables.ts"
import * as movementCorrectionTargets from "./MovementCorrectionTargetsTable.ts"
import * as principals from "./PrincipalsTable.ts"
import * as protocolCandidateObservations from "./ProtocolCandidateObservationsTable.ts"
import * as protocolCandidates from "./ProtocolCandidatesTable.ts"
import * as protocolMappingEvidence from "./ProtocolMappingEvidenceTable.ts"
import * as protocolTransactionTypeMappings from "./ProtocolTransactionTypeMappingsTable.ts"
import * as providerAssetMappings from "./ProviderAssetMappingsTable.ts"
import * as providerAssetSourceUses from "./ProviderAssetSourceUsesTable.ts"
import * as providerAssetTransactionUses from "./ProviderAssetTransactionUsesTable.ts"
import * as providerAssets from "./ProviderAssetsTable.ts"
import * as providerTransfers from "./ProviderTransfersTable.ts"
import * as providerTransactionTypeCatalog from "./ProviderTransactionTypeCatalogTable.ts"
import * as providerTransactionTypeMappings from "./ProviderTransactionTypeMappingsTable.ts"
import * as sessions from "./SessionsTable.ts"
import * as sourceRecordsRaw from "./SourceRecordsRawTable.ts"
import * as sourceRepresentationUses from "./SourceRepresentationUsesTable.ts"
import * as sourceSyncState from "./SourceSyncStateTable.ts"
import * as sources from "./SourcesTable.ts"
import * as syncRunItems from "./SyncRunItemsTable.ts"
import * as syncRuns from "./SyncRunsTable.ts"
import * as transactionCategories from "./TransactionCategoriesTable.ts"
import * as transactionLegs from "./TransactionLegsTable.ts"
import * as transactionOnchainContext from "./TransactionOnchainContextTable.ts"
import * as transactionReview from "./TransactionReviewTable.ts"
import * as transactionSubcategories from "./TransactionSubcategoriesTable.ts"
import * as transactionTypes from "./TransactionTypesTable.ts"
import * as transactionVenueContext from "./TransactionVenueContextTable.ts"
import * as transactions from "./TransactionsTable.ts"
import * as transferReconciliations from "./TransferReconciliationsTable.ts"
import * as transfers from "./TransfersTable.ts"
import * as users from "./UsersTable.ts"
import * as walletNameCache from "./WalletNameCacheTable.ts"

export const schema = {
  ...addresses,
  ...assetDecisionRematerializations,
  ...assetPrices,
  ...assetRepresentations,
  ...assetRepresentationOwnershipDecisions,
  ...assetResolutionCurrentState,
  ...assetResolutionDecisions,
  ...assetResolutionDecisionEvidenceLinks,
  ...assetResolutionEvidence,
  ...assetResolutionJobs,
  ...assets,
  ...blockchains,
  ...billing,
  ...cex,
  ...cexAccount,
  ...calculationRunCorrectionInputs,
  ...calculationRunResults,
  ...calculationRuns,
  ...custodyUnits,
  ...duneProtocolCandidateObservations,
  ...emailVerificationRequests,
  ...identities,
  ...inventoryMovements,
  ...legalRules,
  ...oauthStates,
  ...processingJobDependencies,
  ...processingJobs,
  ...principalClaims,
  ...principalAssetOverrideApplications,
  ...principalAssetOverrides,
  ...movementCorrectionTargets,
  ...principalTransactionOverrides,
  ...principals,
  ...protocolCandidateObservations,
  ...protocolCandidates,
  ...protocolMappingEvidence,
  ...protocolTransactionTypeMappings,
  ...providerAssetMappings,
  ...providerAssetSourceUses,
  ...providerAssetTransactionUses,
  ...providerAssets,
  ...providerTransfers,
  ...providerTransactionTypeCatalog,
  ...providerTransactionTypeMappings,
  ...sessions,
  ...sourceRecordsRaw,
  ...sourceRepresentationUses,
  ...sourceSyncState,
  ...sources,
  ...syncRunItems,
  ...syncRuns,
  ...transactionCategories,
  ...transactionLegs,
  ...transactionOnchainContext,
  ...transactionReview,
  ...transactionSubcategories,
  ...transactionTypes,
  ...transactionVenueContext,
  ...transactions,
  ...transferReconciliations,
  ...transfers,
  ...users,
  ...walletNameCache,
}

export type { Address } from "./AddressesTable.ts"
export type { AssetDecisionRematerialization } from "./AssetDecisionRematerializationsTable.ts"
export type { AssetPrice, AssetPriceInsert } from "./AssetPricesTable.ts"
export type { AssetResolutionDecisionEvidenceLink } from "./AssetResolutionDecisionEvidenceLinksTable.ts"
export type {
  AssetRepresentation,
  AssetRepresentationInsert,
  AssetRepresentationType,
} from "./AssetRepresentationsTable.ts"
export type {
  AssetRepresentationOwnershipDecisionInsert,
  AssetRepresentationOwnershipDecisionRow,
} from "./AssetRepresentationOwnershipDecisionsTable.ts"
export type {
  AssetResolutionDecisionInsert,
  AssetResolutionDecisionRow,
  AssetResolutionOutcome,
} from "./AssetResolutionDecisionsTable.ts"
export type {
  AssetResolutionEvidenceInsert,
  AssetResolutionEvidenceRow,
} from "./AssetResolutionEvidenceTable.ts"
export type { AssetResolutionJob, AssetResolutionJobInsert } from "./AssetResolutionJobsTable.ts"
export type { Asset, AssetInsert, AssetType } from "./AssetsTable.ts"
export type { Blockchain, BlockchainInsert } from "./BlockchainsTable.ts"
export type { BillingAccountRow, CreditLedgerRow, StripeEventRow } from "./BillingTables.ts"
export type { Cex, CexInsert } from "./CexTable.ts"
export type { CexAccount, CexAccountInsert } from "./CexAccountTable.ts"
export type {
  CalculationRunAllocation,
  CalculationRunAllocationInsert,
  CalculationRunBlocker,
  CalculationRunBlockerInsert,
  CalculationRunCustodyUnit,
  CalculationRunCustodyUnitInsert,
  CalculationRunCustodyUnitSource,
  CalculationRunCustodyUnitSourceInsert,
  CalculationRunDerivedLot,
  CalculationRunDerivedLotInsert,
  CalculationRunExplanationEntry,
  CalculationRunExplanationEntryInsert,
  CalculationRunExplanationMatch,
  CalculationRunIncomeResult,
  CalculationRunIncomeResultInsert,
  CalculationRunRealizedResult,
  CalculationRunRealizedResultInsert,
} from "./CalculationRunResultsTables.ts"
export type {
  ActiveCalculationRun,
  ActiveCalculationRunInsert,
  CalculationRun,
  CalculationRunInsert,
} from "./CalculationRunsTables.ts"
export type {
  CustodyUnit,
  CustodyUnitInsert,
  CustodyUnitSource,
  CustodyUnitSourceInsert,
} from "./CustodyUnitsTables.ts"
export type {
  DuneProtocolCandidateObservationInsert,
  DuneProtocolCandidateObservationRow,
} from "./DuneProtocolCandidateObservationsTable.ts"
export type { EmailVerificationRequest } from "./EmailVerificationRequestsTable.ts"
export type { IdentityRow } from "./IdentitiesTable.ts"
export type { InventoryMovement, InventoryMovementInsert } from "./InventoryMovementsTable.ts"
export type {
  JurisdictionRuleSet,
  JurisdictionRuleSetInsert,
  JurisdictionRuleSetRule,
  JurisdictionRuleSetRuleInsert,
  LegalClause,
  LegalClauseInsert,
  LegalRule,
  LegalRuleCitation,
  LegalRuleCitationInsert,
  LegalRuleInsert,
  LegalSource,
  LegalSourceInsert,
  TransactionTypeLegalRule,
  TransactionTypeLegalRuleInsert,
} from "./LegalRulesTable.ts"
export type { OAuthStateRow } from "./OAuthStatesTable.ts"
export type {
  ProcessingJobDependency,
  ProcessingJobDependencyInsert,
} from "./ProcessingJobDependenciesTable.ts"
export type { ProcessingJob, ProcessingJobInsert } from "./ProcessingJobsTable.ts"
export type { PrincipalClaimInsert, PrincipalClaimRow } from "./PrincipalClaimsTable.ts"
export type { PrincipalAssetOverrideApplication } from "./PrincipalAssetOverrideApplicationsTable.ts"
export type {
  PrincipalAssetOverride,
  PrincipalAssetOverrideInsert,
  PrincipalAssetOverrideTarget,
  PrincipalAssetOverrideTargetInsert,
} from "./PrincipalAssetOverridesTables.ts"
export type { PrincipalInsert, PrincipalRow } from "./PrincipalsTable.ts"
export type {
  ProtocolCandidateObservationInsert,
  ProtocolCandidateObservationRow,
  ProtocolCandidateObservationOnchainDataSource,
} from "./ProtocolCandidateObservationsTable.ts"
export type { ProtocolCandidateInsert, ProtocolCandidateRow } from "./ProtocolCandidatesTable.ts"
export type {
  ProtocolMappingEvidenceInsert,
  ProtocolMappingEvidenceKind,
  ProtocolMappingEvidenceRow,
} from "./ProtocolMappingEvidenceTable.ts"
export type {
  ProtocolMovementPattern,
  ProtocolTransactionTypeMappingInsert,
  ProtocolTransactionTypeMappingRow,
} from "./ProtocolTransactionTypeMappingsTable.ts"
export type {
  ProviderAssetMappingKind,
  ProviderAssetMappingInsert,
  ProviderAssetMappingRow,
} from "./ProviderAssetMappingsTable.ts"
export type {
  ProviderAssetSourceUse,
  ProviderAssetSourceUseInsert,
} from "./ProviderAssetSourceUsesTable.ts"
export type {
  ProviderAssetTransactionUse,
  ProviderAssetTransactionUseInsert,
} from "./ProviderAssetTransactionUsesTable.ts"
export type { ProviderAssetInsert, ProviderAssetRow } from "./ProviderAssetsTable.ts"
export type {
  ProviderTransfer,
  ProviderTransferDirection,
  ProviderTransferInsert,
  ProviderTransferProcessingMode,
} from "./ProviderTransfersTable.ts"
export type {
  ProviderTransactionTypeCatalogInsert,
  ProviderTransactionTypeCatalogRow,
} from "./ProviderTransactionTypeCatalogTable.ts"
export type {
  ProviderInventoryEffect,
  ProviderMappingStatus,
  ProviderResolutionStrategy,
  ProviderTaxTreatment,
  ProviderTransactionTypeMappingInsert,
  ProviderTransactionTypeMappingRow,
} from "./ProviderTransactionTypeMappingsTable.ts"
export type { SessionRow } from "./SessionsTable.ts"
export type { SourceRecordRaw, SourceRecordRawInsert } from "./SourceRecordsRawTable.ts"
export type {
  SourceRepresentationUse,
  SourceRepresentationUseInsert,
} from "./SourceRepresentationUsesTable.ts"
export type { SourceSyncState, SourceSyncStateInsert } from "./SourceSyncStateTable.ts"
export type { SourceInsert, SourceRow } from "./SourcesTable.ts"
export type { SyncRunItem, SyncRunItemInsert } from "./SyncRunItemsTable.ts"
export type { SyncRun, SyncRunInsert } from "./SyncRunsTable.ts"
export type { TransactionCategory } from "./TransactionCategoriesTable.ts"
export type {
  LegKind,
  LegProvenance,
  TransactionLeg,
  TransactionLegInsert,
} from "./TransactionLegsTable.ts"
export type {
  TransactionOnchainContext,
  TransactionOnchainContextInsert,
} from "./TransactionOnchainContextTable.ts"
export type {
  ReviewStatus,
  TransactionReview,
  TransactionReviewInsert,
} from "./TransactionReviewTable.ts"
export type { TransactionSubcategory } from "./TransactionSubcategoriesTable.ts"
export type { TransactionType } from "./TransactionTypesTable.ts"
export type {
  TransactionVenueContext,
  TransactionVenueContextInsert,
} from "./TransactionVenueContextTable.ts"
export type { Transaction, TransactionInsert } from "./TransactionsTable.ts"
export type {
  TransferReconciliation,
  TransferReconciliationInsert,
  TransferReconciliationStatus,
} from "./TransferReconciliationsTable.ts"
export type { Transfer, TransferInsert, TransferType } from "./TransfersTable.ts"
export type { UserRow } from "./UsersTable.ts"
export type { WalletNameCacheInsert, WalletNameCacheRow } from "./WalletNameCacheTable.ts"
