import { CacheService } from '@data/CacheService'
import { DataApiService } from '@data/DataApiService'
import { DbService } from '@data/db/DbService'
import { PreferenceService } from '@data/PreferenceService'
import { AiService } from '@main/ai/AiService'
import { McpCatalogService } from '@main/ai/mcp/McpCatalogService'
import { McpPackageService } from '@main/ai/mcp/McpPackageService'
import { McpRuntimeService } from '@main/ai/mcp/McpRuntimeService'
import { TraceStorageService } from '@main/ai/observability'
import { AiStreamManager } from '@main/ai/streamManager'
import { JobManager } from '@main/core/job/JobManager'
import type { ServiceConstructor } from '@main/core/lifecycle'
import { PowerService } from '@main/core/power/PowerService'
import { SchedulerService } from '@main/core/scheduler/SchedulerService'
import { UtilityProcessManager } from '@main/core/utilityProcess/UtilityProcessManager'
import { WindowManager } from '@main/core/window/WindowManager'
import { BrowserSessionService } from '@main/features/browser'
import { FileProcessingService } from '@main/features/fileProcessing'
import { IpcApiService } from '@main/ipc/IpcApiService'
import { AnalyticsService } from '@main/services/AnalyticsService'
import { CommandService } from '@main/services/CommandService'
import { ConversationNavigationService } from '@main/services/ConversationNavigationService'
import { DirectoryTreeManager, FileManager } from '@main/services/file'
import { LogRetentionService } from '@main/services/LogRetentionService'
import { MainWindowService } from '@main/services/MainWindowService'
import { MediaProtocolService } from '@main/services/mediaProtocol'
import { NetworkService } from '@main/services/network'
import { NotificationService } from '@main/services/NotificationService'
import { ProxyService } from '@main/services/proxy/ProxyService'
import { StorageMonitorService } from '@main/services/StorageMonitorService'
import { SubWindowService } from '@main/services/SubWindowService'
import { ThemeService } from '@main/services/ThemeService'
import { TrashService } from '@main/services/trash'
import { TrayService } from '@main/services/TrayService'

import { ManagedChatService } from './ManagedChatService'

export const managedServiceList = [
  DbService,
  CacheService,
  DataApiService,
  IpcApiService,
  PreferenceService,
  AnalyticsService,
  WindowManager,
  UtilityProcessManager,
  MainWindowService,
  ManagedChatService,
  CommandService,
  ConversationNavigationService,
  ThemeService,
  ProxyService,
  NetworkService,
  FileManager,
  DirectoryTreeManager,
  FileProcessingService,
  MediaProtocolService,
  SubWindowService,
  StorageMonitorService,
  LogRetentionService,
  PowerService,
  TrayService,
  NotificationService,
  TraceStorageService,
  SchedulerService,
  JobManager,
  AiStreamManager,
  AiService,
  McpPackageService,
  McpRuntimeService,
  McpCatalogService,
  BrowserSessionService,
  TrashService
] as ServiceConstructor[]
