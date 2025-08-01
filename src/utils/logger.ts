import * as vscode from 'vscode';

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

export class Logger {
    private outputChannel: vscode.OutputChannel;
    private logLevel: LogLevel = LogLevel.INFO;

    constructor(private name: string) {
        this.outputChannel = vscode.window.createOutputChannel(`Terraform Variable Resolver - ${name}`);
        this.loadConfiguration();
    }

    private loadConfiguration(): void {
        try {
            const config = vscode.workspace.getConfiguration('terraformResolver');
            const configLevel = config.get<string>('logLevel', 'info').toLowerCase();
            
            switch (configLevel) {
                case 'debug':
                    this.logLevel = LogLevel.DEBUG;
                    break;
                case 'warn':
                    this.logLevel = LogLevel.WARN;
                    break;
                case 'error':
                    this.logLevel = LogLevel.ERROR;
                    break;
                default:
                    this.logLevel = LogLevel.INFO;
            }
        } catch (error) {
            console.error('Failed to load logger configuration:', error);
        }
    }

    debug(message: string, ...args: any[]): void {
        this.log(LogLevel.DEBUG, message, ...args);
    }

    info(message: string, ...args: any[]): void {
        this.log(LogLevel.INFO, message, ...args);
    }

    warn(message: string, ...args: any[]): void {
        this.log(LogLevel.WARN, message, ...args);
    }

    error(message: string, error?: any, ...args: any[]): void {
        if (error) {
            args.unshift(error);
        }
        this.log(LogLevel.ERROR, message, ...args);
    }

    show(): void {
        this.outputChannel.show();
    }

    dispose(): void {
        try {
            this.outputChannel.dispose();
        } catch (error) {
            console.error('Error disposing logger:', error);
        }
    }

    private log(level: LogLevel, message: string, ...args: any[]): void {
        if (level < this.logLevel) {
            return;
        }

        try {
            const timestamp = new Date().toISOString();
            const levelStr = LogLevel[level];
            const prefix = `[${timestamp}] [${levelStr}] [${this.name}]`;
            
            let logMessage = `${prefix} ${message}`;
            
            if (args.length > 0) {
                const formattedArgs = args.map(arg => {
                    if (arg instanceof Error) {
                        return `\n  Error: ${arg.message}\n  Stack: ${arg.stack}`;
                    } else if (typeof arg === 'object') {
                        try {
                            return `\n  ${JSON.stringify(arg, null, 2)}`;
                        } catch {
                            return `\n  ${String(arg)}`;
                        }
                    } else {
                        return String(arg);
                    }
                }).join(' ');
                
                logMessage += ` ${formattedArgs}`;
            }

            this.outputChannel.appendLine(logMessage);

            // Also log to console for development
            if (level >= LogLevel.ERROR) {
                console.error(logMessage);
            } else if (level >= LogLevel.WARN) {
                console.warn(logMessage);
            } else if (this.logLevel <= LogLevel.DEBUG) {
                console.log(logMessage);
            }
        } catch (error) {
            console.error('Logger failed to write message:', error);
        }
    }
}