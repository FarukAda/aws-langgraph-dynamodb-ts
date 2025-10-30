/**
 * Bundle hints for esbuild to ensure jsonpath and its dependencies are properly included
 * This helps prevent warnings when users bundle this package in AWS Lambda with esbuild
 */

// Import jsonpath to ensure esprima and related dependencies are included
import 'jsonpath';
import 'esprima';
