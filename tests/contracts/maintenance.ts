import type * as Desktop from '../../app/src/shared-helm.js'
import type * as Widget from '../../extension/src/api.js'
// Compile-time producer/consumer compatibility. No runtime daemon/app imports.
import type { DashboardItem, DashboardPlan, OkenaWorkspacePreview, PlanArtifact } from '../../src/items/contract.js'
import type { PlanningResult } from '../../src/plan/application.js'

type Assert<T extends true> = T
type Compatible<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export type PlanDesktop = Assert<Compatible<DashboardPlan, Desktop.DashboardPlan>>
export type PlanWidget = Assert<Compatible<DashboardPlan, Widget.DashboardPlan>>
export type PlanningDesktop = Assert<Compatible<PlanningResult, Desktop.PlanInfo>>
export type PlanningWidget = Assert<Compatible<PlanningResult, Widget.PlanInfo>>
export type ArtifactDesktop = Assert<Compatible<PlanArtifact, Desktop.PlanArtifact>>
export type OkenaDesktop = Assert<Compatible<OkenaWorkspacePreview, Desktop.OkenaWorkspacePreview>>
export type DetailDesktop = Assert<
	Compatible<
		Pick<DashboardItem, 'planArtifacts' | 'okenaWorkspace' | 'knowledgeDeliveries' | 'knowledgeRecovery'>,
		Pick<Desktop.DashboardItem, 'planArtifacts' | 'okenaWorkspace' | 'knowledgeDeliveries' | 'knowledgeRecovery'>
	>
>
