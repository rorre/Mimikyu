declare namespace Express {
    export interface Response {
        isError: boolean
        isWrongStatus?: boolean
        fileId?: string
        isReauth?: boolean
        delayTime: number
    }
}
